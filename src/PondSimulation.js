import { FrogNpc } from "./simulation/FrogNpc.js";

export function createPondSimulation(THREE, input) {
// --------------------------------------------------------------------
      // 1. ENGINE CONFIG & ATMOSPHERE THEMES
      // --------------------------------------------------------------------
      const config = {
        theme: 'day',
        flowSpeed: 0.5,
        reflectionIntensity: 1.0,
        fishCount: 14,
        rippleForceMultiplier: 0.3,
        enableCaustics: true,
        enableLilies: true,
        interactionMode: 'ripple', // ripple, food, flower
        soundEnabled: false
      };

      const themes = {
        day: {
          waterBase: new THREE.Color('#0d3d4b'),
          waterDeep: new THREE.Color('#031820'),
          skyColor: new THREE.Color('#70d4f5'),
          caustics: 'rgba(180, 245, 255, 0.04)',
          pebbles: ['#1e3d48', '#15333d', '#284b57', '#102831']
        },
        twilight: {
          waterBase: new THREE.Color('#191c38'),
          waterDeep: new THREE.Color('#080916'),
          skyColor: new THREE.Color('#f472b6'),
          caustics: 'rgba(240, 190, 255, 0.05)',
          pebbles: ['#292941', '#1d1d32', '#363650', '#131322']
        },
        night: {
          waterBase: new THREE.Color('#05101a'),
          waterDeep: new THREE.Color('#010408'),
          skyColor: new THREE.Color('#38bdf8'),
          caustics: 'rgba(50, 220, 210, 0.05)',
          pebbles: ['#10232d', '#091923', '#18313d', '#061219']
        },
        moss: {
          waterBase: new THREE.Color('#0a291a'),
          waterDeep: new THREE.Color('#02120b'),
          skyColor: new THREE.Color('#a7f3d0'),
          caustics: 'rgba(180, 255, 190, 0.04)',
          pebbles: ['#1c3025', '#12251b', '#294031', '#0c1a12']
        }
      };

      // --------------------------------------------------------------------
      // 2. THREE.JS & WEBGL SETUP
      // --------------------------------------------------------------------
      const canvas = document.getElementById('webglCanvas');
      const renderer = new THREE.WebGLRenderer({
        canvas: canvas,
        antialias: true,
        powerPreference: 'high-performance',
        alpha: false
      });

      let dpr = Math.min(window.devicePixelRatio || 1, 2);
      renderer.setPixelRatio(dpr);
      renderer.setSize(window.innerWidth, window.innerHeight);

      // Main Screen Camera & Scene
      const scene = new THREE.Scene();
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

      // Dual-Pass Underwater RenderTarget Buffer
      const renderTargetWidth = Math.floor(window.innerWidth * dpr);
      const renderTargetHeight = Math.floor(window.innerHeight * dpr);
      const underwaterRenderTarget = new THREE.WebGLRenderTarget(renderTargetWidth, renderTargetHeight, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat
      });

      // Offscreen Underwater 2D Canvas Scene
      const uwCanvas = document.createElement('canvas');
      const uwCtx = uwCanvas.getContext('2d');
      uwCanvas.width = renderTargetWidth;
      uwCanvas.height = renderTargetHeight;

      const foregroundCanvas = document.getElementById('pondForegroundCanvas');
      const foregroundCtx = foregroundCanvas.getContext('2d');
      foregroundCanvas.width = renderTargetWidth;
      foregroundCanvas.height = renderTargetHeight;

      const uwTexture = new THREE.CanvasTexture(uwCanvas);
      uwTexture.minFilter = THREE.LinearFilter;
      uwTexture.magFilter = THREE.LinearFilter;

      // --------------------------------------------------------------------
      // 3. GPU WATER SHADER MATERIAL (HIGH-RES ANALYTIC VECTOR WAVES)
      // --------------------------------------------------------------------
      const MAX_RIPPLES = 32;
      const rippleData = new Float32Array(MAX_RIPPLES * 4); // x, y, age, intensity
      let activeRippleCount = 0;

      const waterVertexShader = `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `;

      const waterFragmentShader = `
        precision highp float;
        varying vec2 vUv;

        uniform sampler2D uUnderwaterTexture;
        uniform vec2 uResolution;
        uniform float uTime;
        uniform float uFlowSpeed;
        uniform float uReflectionIntensity;
        uniform vec4 uRipples[32];
        uniform vec3 uWaterBase;
        uniform vec3 uWaterDeep;
        uniform vec3 uSkyColor;

        // Gerstner Wave Formula for continuous surface flow
        float gerstner(vec2 pos, vec2 dir, float steepness, float wavelength, float speed) {
          float k = 6.2831853 / wavelength;
          float c = sqrt(9.8 / k);
          float f = k * (dot(dir, pos) - c * speed * uTime * uFlowSpeed);
          return steepness * sin(f) / k;
        }

        // Calculate smooth heightfield height at coordinates
        float getWaterHeight(vec2 pos) {
          float h = 0.0;
          
          // Organic fluid directional drift
          h += gerstner(pos, normalize(vec2(1.0, 0.4)), 0.022, 0.22, 0.8);
          h += gerstner(pos, normalize(vec2(0.6, 0.8)), 0.012, 0.12, 1.1);
          h += gerstner(pos, normalize(vec2(-0.4, 0.9)), 0.008, 0.06, 1.4);

          // Sum active interactive ripple wave rings
          for (int i = 0; i < 32; i++) {
            vec4 rip = uRipples[i];
            float age = rip.z;
            if (age <= 0.0 || age > 3.5) continue;

            vec2 ripPos = rip.xy;
            float intensity = rip.w;
            float dist = distance(pos, ripPos);

            float waveRadius = age * 0.27;
            float waveWidth = 0.025;
            float d = abs(dist - waveRadius);

            float temporalDamp = exp(-age * 1.1);
            float spatialDamp = exp(-dist * 2.4);

            if (d < waveWidth * 2.5) {
              float ring = exp(-2.0 * d * d / (waveWidth * waveWidth));
              h += sin((dist - waveRadius) * 45.0) * intensity * 0.006 * ring * temporalDamp * spatialDamp;
            }
          }
          return h;
        }

        void main() {
          vec2 uv = vUv;
          vec2 aspectUv = (vUv - 0.5) * vec2(uResolution.x / uResolution.y, 1.0);

          // Analytical vector normal calculation using finite differences
          float eps = 0.0018;
          float hC = getWaterHeight(aspectUv);
          float hR = getWaterHeight(aspectUv + vec2(eps, 0.0));
          float hU = getWaterHeight(aspectUv + vec2(0.0, eps));

          vec3 normal = normalize(vec3((hC - hR) / eps, (hC - hU) / eps, 1.0));

          // Snell's Law Refraction distortion for underwater scene
          vec2 refractOffset = normal.xy * 0.042;
          vec2 refractUv = clamp(uv + refractOffset, 0.001, 0.999);
          vec3 underwaterColor = texture2D(uUnderwaterTexture, refractUv).rgb;

          // Water depth tint blending
          underwaterColor = mix(underwaterColor, uWaterBase, 0.24);

          // Vector Lighting & Optics
          vec3 viewDir = vec3(0.0, 0.0, 1.0);
          vec3 lightDir = normalize(vec3(-0.4, 0.55, 0.75));

          // Fresnel blend curve between refraction and reflection
          float fresnel = pow(1.0 - max(dot(viewDir, normal), 0.0), 3.0);
          fresnel = mix(0.08, 0.62, fresnel) * uReflectionIntensity;

          // Blinn-Phong Specular Sun Highlights on wave crests
          vec3 halfDir = normalize(lightDir + viewDir);
          float spec = pow(max(dot(normal, halfDir), 0.0), 140.0);
          vec3 specularGlint = vec3(1.0, 0.98, 0.92) * spec * 2.2 * uReflectionIntensity;

          // Sky Reflection Gradient
          vec3 skyReflect = uSkyColor + vec3(0.06, 0.10, 0.14) * normal.y;

          // Final Composite Surface Color
          vec3 finalColor = mix(underwaterColor, skyReflect, fresnel) + specularGlint;

          gl_FragColor = vec4(finalColor, 1.0);
        }
      `;

      const waterUniforms = {
        uUnderwaterTexture: { value: uwTexture },
        uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
        uTime: { value: 0 },
        uFlowSpeed: { value: config.flowSpeed },
        uReflectionIntensity: { value: config.reflectionIntensity },
        uRipples: { value: rippleData },
        uWaterBase: { value: themes.day.waterBase },
        uWaterDeep: { value: themes.day.waterDeep },
        uSkyColor: { value: themes.day.skyColor }
      };

      const waterMaterial = new THREE.ShaderMaterial({
        vertexShader: waterVertexShader,
        fragmentShader: waterFragmentShader,
        uniforms: waterUniforms
      });

      const planeGeo = new THREE.PlaneGeometry(2, 2);
      const waterMesh = new THREE.Mesh(planeGeo, waterMaterial);
      scene.add(waterMesh);

      // --------------------------------------------------------------------
      // 4. INTERACTION & IDLE DETECTION SYSTEM
      // --------------------------------------------------------------------
      const visitorIdleStates = new Map();
      const visitorMotionStates = new Map();
      const visitorDipStates = new Map();
      let idleVisitors = [];
      let activeRipplesList = [];
      const handVisualStates = new Map(); // id -> { dip, ringTimer }
      let droplets = [];
      const handShadowCanvas = document.createElement('canvas');
      handShadowCanvas.width = uwCanvas.width;
      handShadowCanvas.height = uwCanvas.height;
      const handShadowCtx = handShadowCanvas.getContext('2d');

      const lmPoint = (lm, i) => ({ x: lm[i].x * window.innerWidth, y: lm[i].y * window.innerHeight });

      function updateHandVisuals(visitors, dt) {
        const activeIds = new Set();
        visitors.forEach(v => {
          if (!v.active) return;
          activeIds.add(v.id);
          let s = handVisualStates.get(v.id);
          if (!s) {
            s = { dip: v.dipped ? 1 : 0, wasDipped: Boolean(v.dipped), ringTimer: 0 };
            handVisualStates.set(v.id, s);
          }
          const hasLm = v.landmarks?.length >= 21;
          const palm = hasLm ? lmPoint(v.landmarks, 9) : { x: v.x, y: v.y };
          const tips = hasLm
            ? [4, 8, 12, 16, 20].map(i => lmPoint(v.landmarks, i))
            : [{ x: v.x, y: v.y }];

          if (v.dipped && !s.wasDipped) {            // entering the water
            emitRipple(palm.x, palm.y, 2.6);
            tips.forEach(t => emitRipple(t.x, t.y, 1.3));
            playWaterSound('splash', 0.25);
          } else if (!v.dipped && s.wasDipped) {     // leaving the water
            emitRipple(palm.x, palm.y, 1.6);
            for (let i = 0; i < 12; i++) {
              const t = tips[i % tips.length];
              droplets.push({
                x: t.x + (Math.random() - 0.5) * 6, y: t.y,
                vx: (Math.random() - 0.5) * 50,
                h: 0, vh: 110 + Math.random() * 130,
                r: 1.5 + Math.random() * 1.8
              });
            }
            playWaterSound('splash', 0.18);
          }
          s.wasDipped = Boolean(v.dipped);
          s.dip += ((v.dipped ? 1 : 0) - s.dip) * Math.min(1, dt * 10);

          // gentle waterline rings while a hand rests in the water
          if (v.dipped && s.dip > 0.9) {
            s.ringTimer -= dt;
            if (s.ringTimer <= 0) {
              s.ringTimer = v.moved ? 0.25 : 0.8;
              tips.slice(0, 2).forEach(t => emitRipple(t.x, t.y, 0.5));
            }
          }
        });
        for (const id of handVisualStates.keys()) {
          if (!activeIds.has(id)) handVisualStates.delete(id);
        }

        droplets.forEach(d => {
          d.x += d.vx * dt;
          d.h += d.vh * dt;
          d.vh -= 650 * dt;
          if (d.h < 0) { d.landed = true; emitRipple(d.x, d.y, 0.35); }
        });
        droplets = droplets.filter(d => !d.landed);
      }

      function emitRipple(px, py, intensity = 1.0) {
        // Convert screen pixel pos to UV aspect normalized space [-0.5, 0.5]
        const aspectX = (px / window.innerWidth - 0.5) * (window.innerWidth / window.innerHeight);
        const aspectY = (1.0 - py / window.innerHeight - 0.5);

        activeRipplesList.push({
          x: aspectX,
          y: aspectY,
          age: 0,
          intensity: intensity * config.rippleForceMultiplier
        });

        if (activeRipplesList.length > MAX_RIPPLES) {
          activeRipplesList.shift();
        }
      }

      function updateRipples(dt) {
        // Update ages and sync Float32Array uniform
        for (let i = 0; i < MAX_RIPPLES; i++) {
          if (i < activeRipplesList.length) {
            const r = activeRipplesList[i];
            r.age += dt;
            rippleData[i * 4 + 0] = r.x;
            rippleData[i * 4 + 1] = r.y;
            rippleData[i * 4 + 2] = r.age;
            rippleData[i * 4 + 3] = r.intensity;
          } else {
            rippleData[i * 4 + 2] = -1.0; // Inactive
          }
        }
        // Clean up expired ripples
        activeRipplesList = activeRipplesList.filter(r => r.age <= 3.5);
      }

      function handleVisitorMove(visitor) {
        const previous = visitorMotionStates.get(visitor.id);
        const distance = previous
          ? Math.hypot(visitor.x - previous.x, visitor.y - previous.y)
          : 0;
        const speed = Math.max(visitor.speed, distance);
        visitorMotionStates.set(visitor.id, { x: visitor.x, y: visitor.y });

        const hasHandLandmarks = visitor.landmarks?.length >= 21;
        const wasDipped = visitorDipStates.get(visitor.id) ?? false;
        visitorDipStates.set(visitor.id, Boolean(visitor.dipped));

        if (hasHandLandmarks && visitor.dipped && visitor.moved && speed > 1.5) {
          emitHandOutlineRipples(visitor, Math.min(speed * 0.08, 1.2));
        } else if (!hasHandLandmarks && visitor.moved && speed > 1.5) {
          emitRipple(visitor.x, visitor.y, Math.min(speed * 0.08, 1.2));
        }

        if (!visitor.moved) return;

        if (speed > 24) {
          triggerStartle(visitor.x, visitor.y, !hasHandLandmarks);
          playWaterSound('splash', 0.25);
        }
      }

      function handlePointerAction(px, py) {
        if (config.interactionMode === 'ripple') {
          emitRipple(px, py, 2.2);
          playWaterSound('plop', 0.4);
        } else if (config.interactionMode === 'food') {
          dropFoodPellet(px, py);
          playWaterSound('plop', 0.3);
        } else if (config.interactionMode === 'flower') {
          dropFlowerPetal(px, py);
          playWaterSound('plop', 0.2);
        }
      }

      function triggerStartle(x, y, createRipple = true) {
        if (createRipple) emitRipple(x, y, 2.5);
        fishes.forEach(fish => {
          const dx = fish.x - x;
          const dy = fish.y - y;
          const dist = Math.hypot(dx, dy);
          if (dist < 260) {
            if (fish.state !== 'FLEE') {
              fish.state = 'FLEE';
              fish.fleeTimer = 1.3 + Math.random() * 0.7;
            }
            fish.fleeFrom = { x, y };
          }
        });
      }

      // Height ranges from 1 above water to 0 when the hand is dipped.
      function calculateHandDepth(visitor) {
        if (visitor.depth !== undefined) {
          return {
            heightAboveWater: visitor.depth,
            rawZ: visitor.rawZ ?? 0,
            isDipped: Boolean(visitor.dipped)
          };
        }

        if (visitor.landmarks && visitor.landmarks.length >= 21) {
          const avgZ = visitor.landmarks.reduce((sum, lm) => sum + (lm.z || 0), 0) / 21;
          return {
            heightAboveWater: 1.0,
            rawZ: avgZ,
            isDipped: false
          };
        }

        return { heightAboveWater: 1.0, rawZ: 0, isDipped: false };
      }

      function emitHandOutlineRipples(visitor, intensity) {
        if (!visitor.landmarks || visitor.landmarks.length < 21) return;

        const depthInfo = calculateHandDepth(visitor);
        const offsetX = 16 * depthInfo.heightAboveWater;
        const offsetY = 20 * depthInfo.heightAboveWater;
        const outline = [
          0, 1, 2, 3, 4, 8, 7, 6, 5, 9, 10,
          11, 12, 16, 15, 14, 13, 17, 18, 19, 20
        ];
        const sampleCount = 6;
        for (let i = 0; i < sampleCount; i++) {
          const index = outline[Math.floor(i * outline.length / sampleCount)];
          const landmark = visitor.landmarks[index];
          emitRipple(
            landmark.x * window.innerWidth + offsetX,
            landmark.y * window.innerHeight + offsetY,
            intensity
          );
        }
      }

      function getVisitorFishSpots(visitor) {
        if (visitor.landmarks?.length >= 21) {
          return [4, 8, 12, 16, 20, 5, 9, 13, 17].map(index => ({
            x: visitor.landmarks[index].x * window.innerWidth,
            y: visitor.landmarks[index].y * window.innerHeight
          }));
        }
        return [{ x: visitor.x, y: visitor.y }];
      }

      function updateVisitorIdleDetection(visitors, dt) {
        const now = Date.now();
        const activeIds = new Set();
        idleVisitors = [];

        visitors.forEach(visitor => {
          if (!visitor.active) return;
          activeIds.add(visitor.id);
          let state = visitorIdleStates.get(visitor.id);
          if (!state) {
            state = { lastMovedTime: now, idleDuration: 0, isIdle: false };
            visitorIdleStates.set(visitor.id, state);
          }

          if (visitor.moved) {
            state.lastMovedTime = now;
            state.idleDuration = 0;
            state.isIdle = false;
          } else if (now - state.lastMovedTime > 650) {
            state.idleDuration += dt;
            if (state.idleDuration > 0.45) state.isIdle = true;
          } else {
            state.idleDuration = 0;
            state.isIdle = false;
          }

          if (state.isIdle) {
            idleVisitors.push({
              id: visitor.id,
              x: visitor.x,
              y: visitor.y,
              depth: visitor.depth,
              dipped: visitor.dipped,
              landmarks: visitor.landmarks
            });
          }
        });

        for (const id of visitorIdleStates.keys()) {
          if (!activeIds.has(id)) visitorIdleStates.delete(id);
        }
        for (const id of visitorMotionStates.keys()) {
          if (!activeIds.has(id)) {
            visitorMotionStates.delete(id);
            visitorDipStates.delete(id);
          }
        }
      }

      // --------------------------------------------------------------------
      // 5. FLOATING ITEMS (FOOD & SAKURA PETALS)
      // --------------------------------------------------------------------
      let foodPellets = [];
      let sakuraPetals = [];
      let lilyPads = [];
      const frogs = [new FrogNpc(), new FrogNpc()];

      function dropFoodPellet(x, y) {
        foodPellets.push({
          x: x, y: y,
          vx: (Math.random() - 0.5) * 0.4,
          vy: (Math.random() - 0.5) * 0.4,
          size: 4 + Math.random() * 1.5,
          eaten: false
        });
      }

      function dropFlowerPetal(x, y) {
        sakuraPetals.push({
          x: x, y: y,
          vx: (Math.random() - 0.5) * 0.6,
          vy: (Math.random() - 0.5) * 0.6,
          angle: Math.random() * Math.PI * 2,
          vRot: (Math.random() - 0.5) * 0.02,
          scale: 0.8 + Math.random() * 0.4,
          color: Math.random() > 0.3 ? '#ffb7c5' : '#ff9ebb'
        });
      }

      function initLilyPads() {
        lilyPads = [];
        const count = Math.min(7, Math.floor((window.innerWidth * window.innerHeight) / 110000));
        const minGap = 24;
        const maxAttemptsPerPad = 80;

        for (let i = 0; i < count; i++) {
          const radius = 38 + Math.random() * 26;
          let position = null;

          for (let attempt = 0; attempt < maxAttemptsPerPad; attempt++) {
            const marginX = Math.min(radius + minGap, window.innerWidth / 2);
            const marginY = Math.min(radius + minGap, window.innerHeight / 2);
            const x = marginX + Math.random() * (window.innerWidth - marginX * 2);
            const y = marginY + Math.random() * (window.innerHeight - marginY * 2);
            const overlapsExistingPad = lilyPads.some(pad =>
              Math.hypot(pad.x - x, pad.y - y) < pad.radius + radius + minGap
            );

            if (!overlapsExistingPad) {
              position = { x, y };
              break;
            }
          }

          if (!position) continue;

          lilyPads.push({
            x: position.x,
            y: position.y,
            radius,
            rotation: Math.random() * Math.PI * 2,
            notchAngle: Math.random() * Math.PI * 2,
            hasFlower: Math.random() > 0.5
          });
        }
      }

      // --------------------------------------------------------------------
      // 6. MULTI-SEGMENTED SKELETAL KOI FISH AI
      // --------------------------------------------------------------------
      const KOI_PATTERNS = [
        { name: 'Kohaku', base: '#f8f9fa', spots: '#e63946', secondary: null },
        { name: 'Taisho Sanke', base: '#ffffff', spots: '#d90429', secondary: '#111111' },
        { name: 'Yamabuki Ogon', base: '#ffb703', spots: '#fb8500', secondary: null },
        { name: 'Showa', base: '#1a1a1a', spots: '#e63946', secondary: '#ffffff' },
        { name: 'Asagi', base: '#457b9d', spots: '#e63946', secondary: '#e1e5f2' }
      ];

      class KoiFish {
        constructor() {
          this.reset(true);
        }

        reset(randomPos = false) {
          this.x = randomPos ? Math.random() * window.innerWidth : (Math.random() > 0.5 ? -60 : window.innerWidth + 60);
          this.y = randomPos ? Math.random() * window.innerHeight : Math.random() * window.innerHeight;
          this.length = 42 + Math.random() * 26;
          this.speed = 1.2 + Math.random() * 0.6;
          this.maxSpeed = 3.0 + Math.random() * 0.6;
          this.angle = Math.random() * Math.PI * 2;

          this.pattern = KOI_PATTERNS[Math.floor(Math.random() * KOI_PATTERNS.length)];

          // 10-Joint Spine Chain
          this.numSegments = 10;
          this.segLength = this.length / this.numSegments;
          this.spine = [];
          for (let i = 0; i < this.numSegments; i++) {
            this.spine.push({
              x: this.x - Math.cos(this.angle) * i * this.segLength,
              y: this.y - Math.sin(this.angle) * i * this.segLength
            });
          }

          this.bodyWidths = [
            this.length * 0.18, // Head
            this.length * 0.25, // Shoulders
            this.length * 0.26, // Body center
            this.length * 0.23,
            this.length * 0.19,
            this.length * 0.15,
            this.length * 0.11,
            this.length * 0.08,
            this.length * 0.05,
            this.length * 0.02  // Tail base
          ];

          this.swimPhase = Math.random() * Math.PI * 2;
          this.swimFreq = 0.13;

          this.state = 'WANDER'; // WANDER, APPROACH, NIBBLE, EAT, FLEE
          this.target = { x: Math.random() * window.innerWidth, y: Math.random() * window.innerHeight };
          this.changeTargetTimer = Math.random() * 200;
          this.nibbleCooldown = 0;
          this.fleeTimer = 0;
          this.fleeFrom = null;
          this.visitorTarget = null;
        }

        update(dt) {
          const frameScale = dt * 60;
          this.nibbleCooldown = Math.max(0, this.nibbleCooldown - dt);

          // AI State Logic
          if (this.state === 'FLEE') {
            this.fleeTimer -= dt;
            const dx = this.x - this.fleeFrom.x;
            const dy = this.y - this.fleeFrom.y;
            this.angle = Math.hypot(dx, dy) > 0.001
              ? Math.atan2(dy, dx)
              : this.angle + Math.PI;
            this.speed = this.maxSpeed * 1.5;
            if (this.fleeTimer <= 0) this.state = 'WANDER';
          } else if (foodPellets.some(food => !food.eaten)) {
            // Food remains the priority; visitor attraction waits until all
            // available pellets have been eaten.
            let nearestFood = null;
            let minDist = 350;

            for (let food of foodPellets) {
              if (food.eaten) continue;
              const d = Math.hypot(food.x - this.x, food.y - this.y);
              if (d < minDist) {
                minDist = d;
                nearestFood = food;
              }
            }

            if (nearestFood) {
              this.state = 'EAT';
              const targetAngle = Math.atan2(nearestFood.y - this.y, nearestFood.x - this.x);
              let diff = targetAngle - this.angle;
              while (diff < -Math.PI) diff += Math.PI * 2;
              while (diff > Math.PI) diff -= Math.PI * 2;
              this.angle += diff * Math.min(1, 0.08 * frameScale);
              this.speed = 2.0;

              if (minDist < 16) {
                nearestFood.eaten = true;
                emitRipple(nearestFood.x, nearestFood.y, 1.2);
                playWaterSound('nibble', 0.5);
                this.nibbleCooldown = 0.8;
              }
            } else {
              this.wanderLogic(frameScale);
            }
          } else if (this.visitorTarget) {
            const dx = this.visitorTarget.x - this.x;
            const dy = this.visitorTarget.y - this.y;
            const dist = Math.hypot(dx, dy);
            this.state = 'APPROACH';
            const targetAngle = Math.atan2(dy, dx);

            let diff = targetAngle - this.angle;
            while (diff < -Math.PI) diff += Math.PI * 2;
            while (diff > Math.PI) diff -= Math.PI * 2;
            this.angle += diff * Math.min(1, 0.045 * frameScale);

            if (dist > 32) {
              this.speed = 0.9 + Math.sin(Date.now() * 0.003 + this.swimPhase) * 0.3;
            } else if (this.visitorTarget.dipped) {
              this.state = 'NIBBLE';
              this.speed = 0.2;
              if (this.nibbleCooldown <= 0) {
                this.performNibble(this.visitorTarget);
              }
            } else {
              this.state = 'HOVER';
              this.speed = 0.25 + Math.sin(this.swimPhase * 0.5) * 0.1;
            }
          } else {
            this.wanderLogic(frameScale);
          }

          // Flow drift & position advance
          this.x += (Math.cos(this.angle) * this.speed + config.flowSpeed * 0.2) * frameScale;
          this.y += (Math.sin(this.angle) * this.speed + config.flowSpeed * 0.08) * frameScale;

          // Screen wraps
          const margin = 90;
          if (this.x < -margin) this.x = window.innerWidth + margin;
          if (this.x > window.innerWidth + margin) this.x = -margin;
          if (this.y < -margin) this.y = window.innerHeight + margin;
          if (this.y > window.innerHeight + margin) this.y = -margin;

          // Spine Kinematics Propagation
          this.spine[0].x = this.x;
          this.spine[0].y = this.y;

          this.swimPhase += this.swimFreq * (this.speed * 1.2) * frameScale;

          for (let i = 1; i < this.numSegments; i++) {
            const prev = this.spine[i - 1];
            const curr = this.spine[i];

            let dx = curr.x - prev.x;
            let dy = curr.y - prev.y;
            let angle = Math.atan2(dy, dx);

            // Undulating tail wiggle
            const wiggle = Math.sin(this.swimPhase - i * 0.45) * (0.16 * (i / this.numSegments));
            angle += wiggle;

            curr.x = prev.x + Math.cos(angle) * this.segLength;
            curr.y = prev.y + Math.sin(angle) * this.segLength;
          }
        }

        wanderLogic(frameScale) {
          this.state = 'WANDER';
          this.changeTargetTimer -= frameScale;
          if (this.changeTargetTimer <= 0) {
            this.target = {
              x: 100 + Math.random() * (window.innerWidth - 200),
              y: 100 + Math.random() * (window.innerHeight - 200)
            };
            this.changeTargetTimer = 160 + Math.random() * 240;
          }

          const dx = this.target.x - this.x;
          const dy = this.target.y - this.y;
          const targetAngle = Math.atan2(dy, dx);

          let diff = targetAngle - this.angle;
          while (diff < -Math.PI) diff += Math.PI * 2;
          while (diff > Math.PI) diff -= Math.PI * 2;

          this.angle += diff * Math.min(1, 0.025 * frameScale);
          this.speed = 1.1 + Math.sin(this.swimPhase * 0.5) * 0.4;
        }

        performNibble(target) {
          this.nibbleCooldown = 1.1 + Math.random() * 0.7;
          emitRipple(target.x, target.y, 0.7);
          playWaterSound('nibble', 0.4);
        }

        draw(ctx) {
          ctx.save();

          // Compute left and right body contours
          const leftPts = [];
          const rightPts = [];

          for (let i = 0; i < this.numSegments; i++) {
            const p = this.spine[i];
            let normAngle = 0;

            if (i < this.numSegments - 1) {
              const next = this.spine[i + 1];
              normAngle = Math.atan2(next.y - p.y, next.x - p.x) + Math.PI / 2;
            } else {
              const prev = this.spine[i - 1];
              normAngle = Math.atan2(p.y - prev.y, p.x - prev.x) + Math.PI / 2;
            }

            const w = this.bodyWidths[i];
            leftPts.push({ x: p.x + Math.cos(normAngle) * w, y: p.y + Math.sin(normAngle) * w });
            rightPts.push({ x: p.x - Math.cos(normAngle) * w, y: p.y - Math.sin(normAngle) * w });
          }

          // 1. Draw Fins
          ctx.fillStyle = 'rgba(245, 245, 245, 0.55)';
          const pFinBase = this.spine[2];
          const pFinAngle = Math.atan2(this.spine[3].y - this.spine[1].y, this.spine[3].x - this.spine[1].x);
          const finWiggle = Math.sin(this.swimPhase * 1.4) * 0.2;

          // Pectoral Fins
          ctx.beginPath();
          ctx.ellipse(
            pFinBase.x + Math.cos(pFinAngle + Math.PI / 2) * 12,
            pFinBase.y + Math.sin(pFinAngle + Math.PI / 2) * 12,
            this.length * 0.32, this.length * 0.11,
            pFinAngle + Math.PI / 3 + finWiggle, 0, Math.PI * 2
          );
          ctx.fill();

          ctx.beginPath();
          ctx.ellipse(
            pFinBase.x - Math.cos(pFinAngle + Math.PI / 2) * 12,
            pFinBase.y - Math.sin(pFinAngle + Math.PI / 2) * 12,
            this.length * 0.32, this.length * 0.11,
            pFinAngle - Math.PI / 3 - finWiggle, 0, Math.PI * 2
          );
          ctx.fill();

          // Tail Fin
          const tailBase = this.spine[this.numSegments - 1];
          const tailPrev = this.spine[this.numSegments - 2];
          const tailAngle = Math.atan2(tailBase.y - tailPrev.y, tailBase.x - tailPrev.x);

          ctx.beginPath();
          ctx.moveTo(tailBase.x, tailBase.y);
          ctx.lineTo(
            tailBase.x + Math.cos(tailAngle + 0.5) * (this.length * 0.4),
            tailBase.y + Math.sin(tailAngle + 0.5) * (this.length * 0.4)
          );
          ctx.lineTo(
            tailBase.x + Math.cos(tailAngle) * (this.length * 0.5),
            tailBase.y + Math.sin(tailAngle) * (this.length * 0.5)
          );
          ctx.lineTo(
            tailBase.x + Math.cos(tailAngle - 0.5) * (this.length * 0.4),
            tailBase.y + Math.sin(tailAngle - 0.5) * (this.length * 0.4)
          );
          ctx.closePath();
          ctx.fill();

          // 2. Main Body Hull
          ctx.beginPath();
          ctx.moveTo(leftPts[0].x, leftPts[0].y);

          const headTip = {
            x: this.spine[0].x + Math.cos(this.angle) * 9,
            y: this.spine[0].y + Math.sin(this.angle) * 9
          };
          ctx.quadraticCurveTo(headTip.x, headTip.y, rightPts[0].x, rightPts[0].y);

          for (let i = 1; i < this.numSegments; i++) {
            ctx.lineTo(rightPts[i].x, rightPts[i].y);
          }
          ctx.lineTo(leftPts[this.numSegments - 1].x, leftPts[this.numSegments - 1].y);

          for (let i = this.numSegments - 2; i >= 0; i--) {
            ctx.lineTo(leftPts[i].x, leftPts[i].y);
          }
          ctx.closePath();

          ctx.fillStyle = this.pattern.base;
          ctx.fill();

          // 3. Pattern Markings
          ctx.save();
          ctx.clip();

          ctx.fillStyle = this.pattern.spots;
          ctx.beginPath();
          ctx.arc(this.spine[1].x, this.spine[1].y, this.bodyWidths[1] * 0.95, 0, Math.PI * 2);
          ctx.arc(this.spine[4].x, this.spine[4].y, this.bodyWidths[4] * 0.88, 0, Math.PI * 2);
          ctx.arc(this.spine[7].x, this.spine[7].y, this.bodyWidths[7] * 0.78, 0, Math.PI * 2);
          ctx.fill();

          if (this.pattern.secondary) {
            ctx.fillStyle = this.pattern.secondary;
            ctx.beginPath();
            ctx.arc(this.spine[2].x + 4, this.spine[2].y - 3, this.bodyWidths[2] * 0.65, 0, Math.PI * 2);
            ctx.arc(this.spine[5].x - 3, this.spine[5].y + 2, this.bodyWidths[5] * 0.55, 0, Math.PI * 2);
            ctx.fill();
          }

          ctx.restore();

          // Eyes
          const eyeDist = this.bodyWidths[0] * 0.72;
          ctx.fillStyle = '#050505';
          ctx.beginPath();
          ctx.arc(
            this.spine[0].x + Math.cos(this.angle + Math.PI / 3) * eyeDist,
            this.spine[0].y + Math.sin(this.angle + Math.PI / 3) * eyeDist,
            2.3, 0, Math.PI * 2
          );
          ctx.arc(
            this.spine[0].x + Math.cos(this.angle - Math.PI / 3) * eyeDist,
            this.spine[0].y + Math.sin(this.angle - Math.PI / 3) * eyeDist,
            2.3, 0, Math.PI * 2
          );
          ctx.fill();

          ctx.restore();
        }
      }

      let fishes = [];
      function syncFishCount() {
        while (fishes.length < config.fishCount) fishes.push(new KoiFish());
        while (fishes.length > config.fishCount) fishes.pop();
      }

      function assignVisitorTargets() {
        fishes.forEach(fish => { fish.visitorTarget = null; });
        if (foodPellets.some(food => !food.eaten) || idleVisitors.length === 0) return;

        const approachRadius = 480;
        const pairs = [];
        idleVisitors.forEach(visitor => {
          fishes.forEach(fish => {
            const distance = Math.hypot(visitor.x - fish.x, visitor.y - fish.y);
            if (distance <= approachRadius) {
              pairs.push({ fish, visitor, distance });
            }
          });
        });
        pairs.sort((a, b) => a.distance - b.distance);

        const assignedFish = new Set();
        const assignmentsPerVisitor = new Map();
        pairs.forEach(({ fish, visitor }) => {
          if (assignedFish.has(fish)) return;
          const spots = getVisitorFishSpots(visitor);
          const assignedCount = assignmentsPerVisitor.get(visitor.id) ?? 0;
          const spot = spots[assignedCount % spots.length];
          fish.visitorTarget = {
            ...spot,
            dipped: visitor.dipped ?? true
          };
          assignmentsPerVisitor.set(visitor.id, assignedCount + 1);
          assignedFish.add(fish);
        });
      }

      // --------------------------------------------------------------------
      // 7. UNDERWATER SCENE & CAUSTICS RENDERER
      // --------------------------------------------------------------------
      let pebbles = [];
      let decorationViewportWidth = window.innerWidth;
      let decorationViewportHeight = window.innerHeight;
      let decorationDpr = dpr;

      function generatePebbles() {
        pebbles = [];
        const theme = themes[config.theme];
        for (let i = 0; i < 190; i++) {
          const colorIndex = Math.floor(Math.random() * theme.pebbles.length);
          pebbles.push({
            x: Math.random() * uwCanvas.width,
            y: Math.random() * uwCanvas.height,
            rx: (7 + Math.random() * 15) * dpr,
            ry: (5 + Math.random() * 11) * dpr,
            angle: Math.random() * Math.PI,
            colorIndex,
            color: theme.pebbles[colorIndex]
          });
        }
      }

      function recolorPebbles() {
        const palette = themes[config.theme].pebbles;
        pebbles.forEach(pebble => {
          pebble.color = palette[pebble.colorIndex % palette.length];
        });
      }

      function resizeDecorations(oldWidth, oldHeight, oldDpr, width, height, newDpr) {
        const scaleX = width / oldWidth;
        const scaleY = height / oldHeight;
        const scaleDpr = newDpr / oldDpr;

        lilyPads.forEach(pad => {
          pad.x = Math.min(Math.max(pad.x * scaleX, pad.radius), Math.max(pad.radius, width - pad.radius));
          pad.y = Math.min(Math.max(pad.y * scaleY, pad.radius), Math.max(pad.radius, height - pad.radius));
        });

        pebbles.forEach(pebble => {
          pebble.x *= scaleX * scaleDpr;
          pebble.y *= scaleY * scaleDpr;
          pebble.rx *= scaleDpr;
          pebble.ry *= scaleDpr;
        });
      }

      function drawFallbackHandSilhouette(ctx, x, y, offsetX, offsetY) {
        ctx.beginPath();
        ctx.ellipse(x + offsetX, y + offsetY, 20, 25, 0, 0, Math.PI * 2);
        ctx.fill();
        for (let finger = 0; finger < 4; finger++) {
          const fingerX = x + offsetX - 13 + finger * 9;
          const fingerY = y + offsetY - 38 + Math.abs(1.5 - finger) * 2;
          ctx.beginPath();
          ctx.roundRect(fingerX - 3.5, fingerY, 7, 24, 3.5);
          ctx.fill();
        }
        ctx.beginPath();
        ctx.roundRect(x + offsetX + 13, y + offsetY - 12, 9, 24, 4.5);
        ctx.fill();
      }

      const HAND_CHAINS = [
        { ids: [1, 2, 3, 4], w: 0.26 },
        { ids: [5, 6, 7, 8], w: 0.20 },
        { ids: [9, 10, 11, 12], w: 0.20 },
        { ids: [13, 14, 15, 16], w: 0.19 },
        { ids: [17, 18, 19, 20], w: 0.17 }
      ];
      const PALM_RING = [0, 1, 5, 9, 13, 17];

      // Opaque glove silhouette: palm + tapered rounded fingers + wrist.
      function traceGloveSilhouette(ctx, lm, ox, oy, color) {
        const W = window.innerWidth, H = window.innerHeight;
        const P = i => ({ x: lm[i].x * W + ox, y: lm[i].y * H + oy });
        const palm = Math.max(20, Math.hypot((lm[0].x - lm[9].x) * W, (lm[0].y - lm[9].y) * H));

        ctx.fillStyle = color;
        ctx.strokeStyle = color;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // palm: closed curve through midpoints, so there are no sharp corners
        const ring = PALM_RING.map(P);
        ctx.beginPath();
        ring.forEach((p, k) => {
          const next = ring[(k + 1) % ring.length];
          const mx = (p.x + next.x) / 2, my = (p.y + next.y) / 2;
          if (k === 0) {
            const prev = ring[ring.length - 1];
            ctx.moveTo((prev.x + p.x) / 2, (prev.y + p.y) / 2);
          }
          ctx.quadraticCurveTo(p.x, p.y, mx, my);
        });
        ctx.closePath();
        ctx.fill();
        ctx.lineWidth = palm * 0.32;
        ctx.stroke();

        // fingers: one continuous smooth stroke each
        HAND_CHAINS.forEach(({ ids, w }) => {
          const pts = ids.map(P);
          ctx.lineWidth = palm * w * 0.95;
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let k = 1; k < pts.length - 1; k++) {
            const mx = (pts[k].x + pts[k + 1].x) / 2;
            const my = (pts[k].y + pts[k + 1].y) / 2;
            ctx.quadraticCurveTo(pts[k].x, pts[k].y, mx, my);
          }
          const last = pts[pts.length - 1];
          ctx.lineTo(last.x, last.y);
          ctx.stroke();
        });

        // wrist
        const w0 = P(0), w9 = P(9);
        const dx = w0.x - w9.x, dy = w0.y - w9.y, len = Math.hypot(dx, dy) || 1;
        ctx.lineWidth = palm * 0.5;
        ctx.beginPath();
        ctx.moveTo(w0.x, w0.y);
        ctx.lineTo(w0.x + dx / len * palm * 0.9, w0.y + dy / len * palm * 0.9);
        ctx.stroke();
      }

      function compositeHandLayer(ctx, alpha, blurCssPx) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = alpha;
        if (typeof ctx.filter === 'string') ctx.filter = `blur(${blurCssPx * dpr}px)`;
        ctx.drawImage(handShadowCanvas, 0, 0);
        ctx.restore();
      }

      function renderHandShadowsOnPondFloor(ctx, visitors) {
        if (!visitors || visitors.length === 0) return;
        if (handShadowCanvas.width !== uwCanvas.width || handShadowCanvas.height !== uwCanvas.height) {
          handShadowCanvas.width = uwCanvas.width;
          handShadowCanvas.height = uwCanvas.height;
        }

        visitors.forEach(visitor => {
          if (!visitor.active) return;
          const dip = handVisualStates.get(visitor.id)?.dip ?? (visitor.dipped ? 1 : 0);
          const h = 1 - dip;                          // 1 = hovering, 0 = in the water
          const ox = 4 + 22 * h, oy = 5 + 28 * h;     // hovering shadow sits further away
          const hasLm = visitor.landmarks?.length >= 21 &&
            visitor.landmarks.every(l => Number.isFinite(l.x) && Number.isFinite(l.y));

          // 1. shadow: soft + faint in the air, tight + dark in the water
          handShadowCtx.setTransform(1, 0, 0, 1, 0, 0);
          handShadowCtx.clearRect(0, 0, handShadowCanvas.width, handShadowCanvas.height);
          handShadowCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
          if (hasLm) traceGloveSilhouette(handShadowCtx, visitor.landmarks, ox, oy, '#020a10');
          else {
            handShadowCtx.fillStyle = '#020a10';
            drawFallbackHandSilhouette(handShadowCtx, visitor.x, visitor.y, ox, oy);
          }
          compositeHandLayer(ctx, 0.26 + 0.34 * dip, 3 + 9 * h);

          // 2. submerged hand: dark shadow, only while dipped
          if (hasLm && dip > 0.05) {
            handShadowCtx.setTransform(1, 0, 0, 1, 0, 0);
            handShadowCtx.clearRect(0, 0, handShadowCanvas.width, handShadowCanvas.height);
            handShadowCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
            traceGloveSilhouette(handShadowCtx, visitor.landmarks, 0, 0, '#000000');
            compositeHandLayer(ctx, 0.5 * dip, 2.5);
          }
        });
      }

      let causticTime = 0;
      function renderUnderwaterScene(dt, visitors) {
        causticTime += dt * 1.5;

        // Clear & Draw Pebble Bed Background
        uwCtx.fillStyle = '#031820';
        uwCtx.fillRect(0, 0, uwCanvas.width, uwCanvas.height);

        // pebbles.forEach(p => {
        //   uwCtx.save();
        //   uwCtx.translate(p.x, p.y);
        //   uwCtx.rotate(p.angle);
        //   uwCtx.fillStyle = p.color;
        //   uwCtx.beginPath();
        //   uwCtx.ellipse(0, 0, p.rx, p.ry, 0, 0, Math.PI * 2);
        //   uwCtx.fill();
        //   uwCtx.restore();
        // });

        // Procedural Light Caustics Pass
        // if (config.enableCaustics) {
        //   uwCtx.save();
        //   uwCtx.fillStyle = themes[config.theme].caustics;
        //   const cols = 10;
        //   const rows = 7;
        //   const cellW = uwCanvas.width / cols;
        //   const cellH = uwCanvas.height / rows;

        //   for (let r = 0; r < rows; r++) {
        //     for (let c = 0; c < cols; c++) {
        //       const x = c * cellW + cellW / 2;
        //       const y = r * cellH + cellH / 2;

        //       const offsetX = Math.sin(causticTime + c * 0.7 + r * 0.5) * 12 * dpr;
        //       const offsetY = Math.cos(causticTime * 0.9 + c * 0.4 + r * 0.8) * 12 * dpr;
        //       const radius = (14 + Math.sin(causticTime * 1.1 + c + r) * 6) * dpr;

        //       uwCtx.beginPath();
        //       uwCtx.arc(x + offsetX, y + offsetY, radius, 0, Math.PI * 2);
        //       uwCtx.fill();
        //     }
        //   }
        //   uwCtx.restore();
        // }

        // Render Fish Underwater
        renderHandShadowsOnPondFloor(uwCtx, visitors);
        uwCtx.save();
        uwCtx.scale(dpr, dpr);
        fishes.forEach(fish => {
          fish.update(dt);
          fish.draw(uwCtx);
        });

        // Render Floating Pellets & Petals
        foodPellets.forEach(f => {
          if (f.eaten) return;
          uwCtx.fillStyle = '#d97706';
          uwCtx.beginPath();
          uwCtx.arc(f.x, f.y, f.size, 0, Math.PI * 2);
          uwCtx.fill();
        });

        // sakuraPetals.forEach(p => {
        //   uwCtx.save();
        //   uwCtx.translate(p.x, p.y);
        //   uwCtx.rotate(p.angle);
        //   uwCtx.fillStyle = p.color;
        //   uwCtx.beginPath();
        //   uwCtx.ellipse(0, 0, 8 * p.scale, 4 * p.scale, 0, 0, Math.PI * 2);
        //   uwCtx.fill();
        //   uwCtx.restore();

        //   p.x += config.flowSpeed * 0.3 + p.vx;
        //   p.y += config.flowSpeed * 0.1 + p.vy;
        //   p.angle += p.vRot;
        // });

        uwCtx.restore();

        // Flag Three.js texture for WebGL update
        uwTexture.needsUpdate = true;
      }

      function renderForegroundScene(dt, visitors = []) {
        const width = window.innerWidth;
        const height = window.innerHeight;
        foregroundCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        foregroundCtx.clearRect(0, 0, width, height);

        if (config.enableLilies) {
          lilyPads.forEach(pad => {
            foregroundCtx.save();
            foregroundCtx.translate(pad.x, pad.y);
            foregroundCtx.rotate(pad.rotation);

            const padGrad = foregroundCtx.createRadialGradient(0, 0, 4, 0, 0, pad.radius);
            padGrad.addColorStop(0, '#4f865c');
            padGrad.addColorStop(0.85, '#347247');
            padGrad.addColorStop(1, '#245535');

            foregroundCtx.fillStyle = padGrad;
            foregroundCtx.beginPath();
            foregroundCtx.arc(0, 0, pad.radius, pad.notchAngle + 0.25, pad.notchAngle + Math.PI * 1.85);
            foregroundCtx.lineTo(0, 0);
            foregroundCtx.closePath();
            foregroundCtx.fill();

            if (pad.hasFlower) {
              foregroundCtx.fillStyle = '#ffffff';
              for (let petal = 0; petal < 8; petal++) {
                const angle = (petal / 8) * Math.PI * 2;
                foregroundCtx.beginPath();
                foregroundCtx.ellipse(
                  Math.cos(angle) * 8,
                  Math.sin(angle) * 8,
                  10,
                  4,
                  angle,
                  0,
                  Math.PI * 2
                );
                foregroundCtx.fill();
              }
              foregroundCtx.fillStyle = '#ffb703';
              foregroundCtx.beginPath();
              foregroundCtx.arc(0, 0, 5, 0, Math.PI * 2);
              foregroundCtx.fill();
            }

            foregroundCtx.restore();
          });
        }

        frogs.forEach(frog => {
          frog.update(dt, width, height, lilyPads, config.enableLilies);
          frog.consumeWaterRippleEvents().forEach(ripple => {
            emitRipple(ripple.x, ripple.y, 0.18);
          });
          frog.draw(foregroundCtx);
        });
        // hand state markers
        visitors.forEach(v => {
          if (!v.active) return;
          const s = handVisualStates.get(v.id);
          const dip = s?.dip ?? 0;
          const r = 13 + 9 * (1 - dip);
          foregroundCtx.save();
          foregroundCtx.lineWidth = 2;
          if (dip > 0.5) {
            foregroundCtx.fillStyle = `rgba(56, 189, 248, ${0.22 * dip})`;
            foregroundCtx.strokeStyle = `rgba(125, 220, 255, ${0.9 * dip})`;
            foregroundCtx.beginPath();
            foregroundCtx.arc(v.x, v.y, r, 0, Math.PI * 2);
            foregroundCtx.fill();
            foregroundCtx.stroke();
          } else {
            foregroundCtx.setLineDash([4, 5]);
            foregroundCtx.strokeStyle = `rgba(255, 255, 255, ${0.35 + 0.3 * (1 - dip)})`;
            foregroundCtx.beginPath();
            foregroundCtx.arc(v.x, v.y, r, 0, Math.PI * 2);
            foregroundCtx.stroke();
          }
          foregroundCtx.restore();
        });

        // water droplets flung off the hand
        droplets.forEach(d => {
          foregroundCtx.fillStyle = 'rgba(2, 10, 16, 0.18)';          // shadow on the water
          foregroundCtx.beginPath();
          foregroundCtx.ellipse(d.x + 4, d.y + 5, d.r, d.r * 0.6, 0, 0, Math.PI * 2);
          foregroundCtx.fill();
          foregroundCtx.fillStyle = 'rgba(225, 245, 255, 0.85)';      // droplet
          foregroundCtx.beginPath();
          foregroundCtx.arc(d.x, d.y - d.h, d.r, 0, Math.PI * 2);
          foregroundCtx.fill();
          foregroundCtx.fillStyle = 'rgba(255, 255, 255, 0.9)';       // highlight
          foregroundCtx.beginPath();
          foregroundCtx.arc(d.x - d.r * 0.3, d.y - d.h - d.r * 0.3, d.r * 0.35, 0, Math.PI * 2);
          foregroundCtx.fill();
        });
      }

      // --------------------------------------------------------------------
      // 8. PROCEDURAL WEB AUDIO SYNTHESIZER
      // --------------------------------------------------------------------
      let audioCtx = null;
      function initAudio() {
        if (!audioCtx) {
          const AudioContext = window.AudioContext || window.webkitAudioContext;
          audioCtx = new AudioContext();
        }
        if (audioCtx.state === 'suspended') audioCtx.resume();
      }

      function playWaterSound(type, volume = 0.3) {
        if (!config.soundEnabled || !audioCtx) return;

        try {
          const now = audioCtx.currentTime;
          if (type === 'plop' || type === 'nibble') {
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();

            const startFreq = type === 'nibble' ? 650 + Math.random() * 300 : 320 + Math.random() * 140;
            osc.type = 'sine';
            osc.frequency.setValueAtTime(startFreq, now);
            osc.frequency.exponentialRampToValueAtTime(startFreq + 220, now + 0.12);

            gain.gain.setValueAtTime(volume, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start(now);
            osc.stop(now + 0.13);
          } else if (type === 'splash') {
            const bufferSize = audioCtx.sampleRate * 0.18;
            const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
            const data = buffer.getChannelData(0);
            for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

            const noise = audioCtx.createBufferSource();
            noise.buffer = buffer;

            const filter = audioCtx.createBiquadFilter();
            filter.type = 'bandpass';
            filter.frequency.value = 850;

            const gain = audioCtx.createGain();
            gain.gain.setValueAtTime(volume * 0.6, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);

            noise.connect(filter);
            filter.connect(gain);
            gain.connect(audioCtx.destination);
            noise.start(now);
          }
        } catch (e) {
          console.warn("Audio play prevented", e);
        }
      }

      // --------------------------------------------------------------------
      // 9. MAIN WEBGL RENDERING LOOP
      // --------------------------------------------------------------------
      let lastTime = performance.now();

      function animate() {
        const now = performance.now();
        const dt = Math.min(0.1, (now - lastTime) / 1000);
        lastTime = now;

        const inputState = input.update();
        const visitorInputs = inputState.visitors ?? [];
        updateVisitorIdleDetection(visitorInputs, dt);
        assignVisitorTargets();
        visitorInputs.forEach(visitor => {
          handleVisitorMove(visitor);
          if (visitor.action) handlePointerAction(visitor.x, visitor.y);
        });
        updateHandVisuals(visitorInputs, dt);
        updateRipples(dt);
        renderUnderwaterScene(dt, visitorInputs);
        renderForegroundScene(dt, visitorInputs);

        // 1. Update interactive wave state
        updateRipples(dt);

        // 2. Render Underwater canvas texture scene
        renderUnderwaterScene(dt, visitorInputs);
        renderForegroundScene(dt);

        // 3. Update WebGL Water Shader Uniforms
        waterUniforms.uTime.value += dt;

        // 4. Render main screen WebGL shader mesh
        renderer.render(scene, camera);

        requestAnimationFrame(animate);
      }

      // --------------------------------------------------------------------
      // 10. UI & EVENT CONTROLS
      // --------------------------------------------------------------------
      function setupUI() {
        // Theme switching
        document.querySelectorAll('#themeButtons button').forEach(btn => {
          btn.addEventListener('click', (e) => {
            document.querySelectorAll('#themeButtons button').forEach(b => b.classList.remove('active'));
            const b = e.currentTarget;
            b.classList.add('active');
            config.theme = b.dataset.theme;

            const t = themes[config.theme];
            waterUniforms.uWaterBase.value = t.waterBase;
            waterUniforms.uWaterDeep.value = t.waterDeep;
            waterUniforms.uSkyColor.value = t.skyColor;
            recolorPebbles();
          });
        });

        // Mode toggles
        const modeButtons = [
          { id: 'btnModeRipple', mode: 'ripple' },
          { id: 'btnModeFood', mode: 'food' },
          { id: 'btnModeFlower', mode: 'flower' }
        ];
        modeButtons.forEach(item => {
          document.getElementById(item.id).addEventListener('click', () => {
            modeButtons.forEach(b => document.getElementById(b.id).classList.remove('active'));
            document.getElementById(item.id).classList.add('active');
            config.interactionMode = item.mode;
          });
        });

        document.getElementById('btnClearAll').addEventListener('click', () => {
          foodPellets = [];
          sakuraPetals = [];
        });

        // Sliders
        const flowSlider = document.getElementById('flowSpeedSlider');
        flowSlider.addEventListener('input', (e) => {
          config.flowSpeed = parseFloat(e.target.value);
          waterUniforms.uFlowSpeed.value = config.flowSpeed;
          document.getElementById('flowSpeedVal').textContent = config.flowSpeed.toFixed(2) + 'x';
        });

        const reflectSlider = document.getElementById('reflectionSlider');
        reflectSlider.addEventListener('input', (e) => {
          config.reflectionIntensity = parseFloat(e.target.value);
          waterUniforms.uReflectionIntensity.value = config.reflectionIntensity;
          document.getElementById('reflectionVal').textContent = config.reflectionIntensity.toFixed(1) + 'x';
        });

        const fishSlider = document.getElementById('fishCountSlider');
        fishSlider.addEventListener('input', (e) => {
          config.fishCount = parseInt(e.target.value);
          document.getElementById('fishCountVal').textContent = config.fishCount;
          syncFishCount();
        });

        const forceSlider = document.getElementById('rippleForceSlider');
        forceSlider.addEventListener('input', (e) => {
          config.rippleForceMultiplier = parseFloat(e.target.value);
          document.getElementById('rippleForceVal').textContent = config.rippleForceMultiplier.toFixed(1) + 'x';
        });

        // Checkboxes
        document.getElementById('chkCaustics').addEventListener('change', (e) => { config.enableCaustics = e.target.checked; });
        document.getElementById('chkLilies').addEventListener('change', (e) => { config.enableLilies = e.target.checked; });

        // Settings Drawer
        const drawer = document.getElementById('settingsDrawer');
        document.getElementById('menuToggleBtn').addEventListener('click', () => drawer.classList.remove('translate-x-full'));
        document.getElementById('closeSettingsBtn').addEventListener('click', () => drawer.classList.add('translate-x-full'));

        // Sound Toggle
        const soundBtn = document.getElementById('soundToggleBtn');
        const soundIcon = document.getElementById('soundIcon');
        soundBtn.addEventListener('click', () => {
          config.soundEnabled = !config.soundEnabled;
          if (config.soundEnabled) {
            initAudio();
            soundBtn.classList.add('active');
            soundIcon.className = 'fa-solid fa-volume-high text-sm text-cyan-300';
          } else {
            soundBtn.classList.remove('active');
            soundIcon.className = 'fa-solid fa-volume-xmark text-sm';
          }
        });

        // Window Resizing
        window.addEventListener('resize', () => {
          const previousWidth = decorationViewportWidth;
          const previousHeight = decorationViewportHeight;
          const previousDpr = decorationDpr;
          const w = window.innerWidth;
          const h = window.innerHeight;
          const newDpr = Math.min(window.devicePixelRatio || 1, 2);

          dpr = newDpr;
          renderer.setPixelRatio(newDpr);
          renderer.setSize(w, h);

          uwCanvas.width = Math.floor(w * newDpr);
          uwCanvas.height = Math.floor(h * newDpr);
          foregroundCanvas.width = Math.floor(w * newDpr);
          foregroundCanvas.height = Math.floor(h * newDpr);

          waterUniforms.uResolution.value.set(w, h);
          resizeDecorations(previousWidth, previousHeight, previousDpr, w, h, newDpr);
          decorationViewportWidth = w;
          decorationViewportHeight = h;
          decorationDpr = newDpr;
        });
      }

      // Initialize Everything
      generatePebbles();
      initLilyPads();
      syncFishCount();
      setupUI();

      // Kick off WebGL Render Loop
      animate();
}
