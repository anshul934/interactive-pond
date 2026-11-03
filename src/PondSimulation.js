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
        enableLilies: true,
        interactionMode: 'ripple', // ripple or food
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
      uwTexture.premultiplyAlpha = true;   // transparent canvas composites cleanly

      // --------------------------------------------------------------------
      // 3. GPU WATER SHADER MATERIAL (HIGH-RES ANALYTIC VECTOR WAVES)
      // --------------------------------------------------------------------
      const MAX_RIPPLES = 32;
      const rippleData = new Float32Array(MAX_RIPPLES * 4); // x, y, age, intensity
      let activeRippleCount = 0;
      const MAX_SPLASH_WAVES = 8;
      const SPLASH_WAVE_LIFE = 2.6;
      const splashWaveData = new Float32Array(MAX_SPLASH_WAVES * 4); // x, y, age, intensity
      const splashDirData = new Float32Array(MAX_SPLASH_WAVES * 4);  // dirX, dirY, 0, 0
      let splashWaves = [];

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
        uniform vec4 uSplashWaves[8];
        uniform vec4 uSplashDirs[8];
        uniform vec3 uWaterBase;
        uniform vec3 uWaterDeep;
        uniform vec3 uSkyColor;

        // ---------- DEPTH FIELD (mirrored in JS as waterDepthAt) ----------
        float shoreWobble(vec2 p) {
          return 0.05 * sin(p.x * 5.0 + 1.3 * sin(p.y * 3.0)) + 0.04 * sin(p.y * 7.0 + p.x * 2.0);
        }
        float shoreRadius(vec2 p) {
          float aspect = uResolution.x / uResolution.y;
          vec2 q = abs(p) / vec2(aspect * 0.5, 0.5);
          return pow(q.x * q.x * q.x + q.y * q.y * q.y, 1.0 / 3.0) + shoreWobble(p);
        }
        // 0 = shoreline, 1 = deepest. Shallow band is the outer ~25%.
        float waterDepth(vec2 p) {
          return 1.0 - smoothstep(0.2, 1.0, shoreRadius(p));
        }

        // ---------- BOTTOM (visible only in shallows) ----------
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vnoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
                    mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
        }
        float causticPattern(vec2 p, float t) {
          vec2 a = p * 10.0;
          float v = sin(a.x + t * 0.8 + sin(a.y * 1.3 + t * 0.6)) +
                    sin(a.y * 1.1 - t * 0.7 + sin(a.x * 0.9 - t * 0.5));
          v = 1.0 - abs(v * 0.5);
          return pow(clamp(v, 0.0, 1.0), 6.0);
        }
        vec3 pondBed(vec2 p) {
          float n = vnoise(p * 14.0) * 0.6 + vnoise(p * 40.0) * 0.4;
          vec3 bed = mix(uWaterBase * 1.6, uWaterBase * 2.6 + vec3(0.05, 0.05, 0.03), n);
          bed += vec3(0.55, 0.85, 0.80) * causticPattern(p, uTime * (0.4 + uFlowSpeed)) * 0.22;
          return bed;
        }

        // ---------- WAVES ----------
        float gerstner(vec2 pos, vec2 dir, float steepness, float wavelength, float speed) {
          float k = 6.2831853 / wavelength;
          float c = sqrt(9.8 / k);
          float f = k * (dot(dir, pos) - c * speed * uTime * uFlowSpeed);
          return steepness * sin(f) / k;
        }

        float getWaterHeight(vec2 pos) {
          float depth = waterDepth(pos);
          float swell = mix(0.35, 1.0, depth);   // big swells only build up in deep water
          float chop  = 1.0 - depth;             // small fast chop lives in the shallows

          float h = 0.0;
          h += gerstner(pos, normalize(vec2(1.0, 0.4)),  0.022 * swell, 0.22, 0.8);
          h += gerstner(pos, normalize(vec2(0.6, 0.8)),  0.012 * swell, 0.12, 1.1);
          h += gerstner(pos, normalize(vec2(-0.4, 0.9)), 0.008,         0.06, 1.4);
          h += gerstner(pos, normalize(vec2(-0.8, 0.5)), 0.006 * chop,  0.045, 1.7);

          for (int i = 0; i < 32; i++) {
            vec4 rip = uRipples[i];
            float age = rip.z;
            if (age <= 0.0 || age > 3.5) continue;

            vec2 ripPos = rip.xy;
            float intensity = rip.w;
            float dist = distance(pos, ripPos);

            // Shallow water: slower, quicker-dying ripples (depth taken at the ripple origin)
            float ripDepth = waterDepth(ripPos);
            float waveRadius = age * 0.27 * mix(0.55, 1.0, ripDepth);
            float waveWidth = mix(0.016, 0.034, ripDepth);
            float d = abs(dist - waveRadius);

            float temporalDamp = exp(-age * mix(1.9, 1.1, ripDepth));
            float spatialDamp = exp(-dist * 2.4);

            if (d < waveWidth * 2.5) {
              float ring = exp(-2.0 * d * d / (waveWidth * waveWidth));
              h += sin((dist - waveRadius) * mix(62.0, 32.0, ripDepth)) * intensity * 0.006 * ring *
                  temporalDamp * spatialDamp * mix(0.6, 1.0, depth);
            }
          }

          for (int i = 0; i < 8; i++) {
            vec4 sw = uSplashWaves[i];
            float sAge = sw.z;
            if (sAge <= 0.0 || sAge > 2.6) continue;

            vec2 dir = uSplashDirs[i].xy;
            vec2 rel = pos - sw.xy;
            float relLen = length(rel);
            float along = dot(rel, dir);
            float across = dot(rel, vec2(-dir.y, dir.x));

            float squash = along > 0.0 ? 0.62 : 1.7;
            float sDist = length(vec2(along * squash, across));
            float sRadius = sAge * 0.30;
            float sD = abs(sDist - sRadius);
            float sWidth = 0.03;

            float facing = relLen > 0.0001 ? along / relLen : 1.0;
            float directional = mix(0.3, 1.0, facing * 0.5 + 0.5);
            float sTemporal = exp(-sAge * 1.3);
            float sSpatial = exp(-sDist * 2.0);

            if (sD < sWidth * 2.5) {
              float sRing = exp(-2.0 * sD * sD / (sWidth * sWidth));
              h += sin((sDist - sRadius) * 38.0) * sw.w * 0.008 * sRing * directional *
                  sTemporal * sSpatial * mix(0.6, 1.0, depth);
            }
          }
          return h;
        }

        void main() {
          vec2 uv = vUv;
          float aspect = uResolution.x / uResolution.y;
          vec2 aspectUv = (vUv - 0.5) * vec2(aspect, 1.0);
          float depth = waterDepth(aspectUv);

          float eps = 0.0018;
          float hC = getWaterHeight(aspectUv);
          float hR = getWaterHeight(aspectUv + vec2(eps, 0.0));
          float hU = getWaterHeight(aspectUv + vec2(0.0, eps));
          vec3 normal = normalize(vec3((hC - hR) / eps, (hC - hU) / eps, 1.0));

          // Refraction: weak in shallows, stronger in deep water
          vec2 refractOffset = normal.xy * 0.042 * mix(0.55, 1.15, depth);
          vec2 refractUv = clamp(uv + refractOffset, 0.001, 0.999);
          vec4 uw = texture2D(uUnderwaterTexture, refractUv);   // premultiplied fish/shadows

          // Pond floor, seen through the refracted surface
          vec2 bedPos = (refractUv - 0.5) * vec2(aspect, 1.0);
          float bedVisible = pow(1.0 - depth, 1.6);
          vec3 bed = pondBed(bedPos) * bedVisible;
          vec3 column = mix(bed, uWaterDeep, smoothstep(0.0, 1.0, depth) * 0.92);

          // Fish: lose contrast and sink into the murk as the water gets deeper
          vec3 creature = mix(uw.rgb, uWaterDeep * uw.a, depth * 0.35);
          vec3 underwaterColor = creature + column * (1.0 - uw.a);

          underwaterColor = mix(underwaterColor, uWaterBase, mix(0.08, 0.34, depth));

          vec3 viewDir = vec3(0.0, 0.0, 1.0);
          vec3 lightDir = normalize(vec3(-0.4, 0.55, 0.75));

          float fresnel = pow(1.0 - max(dot(viewDir, normal), 0.0), 3.0);
          fresnel = mix(0.08, 0.62, fresnel) * uReflectionIntensity * mix(0.55, 1.0, depth);

          vec3 halfDir = normalize(lightDir + viewDir);
          float spec = pow(max(dot(normal, halfDir), 0.0), 140.0);
          vec3 specularGlint = vec3(1.0, 0.98, 0.92) * spec * 2.2 * uReflectionIntensity;

          vec3 skyReflect = uSkyColor + vec3(0.06, 0.10, 0.14) * normal.y;
          vec3 finalColor = mix(underwaterColor, skyReflect, fresnel) + specularGlint;

          // Gentle lapping highlight right at the waterline
          float rim = 1.0 - smoothstep(0.0, 0.14, depth);
          float lap = 0.5 + 0.5 * sin(depth * 90.0 - uTime * 1.2);
          finalColor += vec3(0.75, 0.95, 0.95) * rim * smoothstep(0.7, 1.0, lap) * 0.07;

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
        uSplashWaves: { value: splashWaveData },
        uSplashDirs: { value: splashDirData },
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
          const feel = handDepthFeel(palm.x, palm.y);

          if (v.dipped && !s.wasDipped) {            // entering the water
            emitRipple(palm.x, palm.y, 2.6 * feel.ripple);
            tips.forEach(t => emitRipple(t.x, t.y, 1.3 * feel.ripple));
            emitSplash(tips, 1800, 0, 0, feel.spray);
            playWaterSound('splash', 0.25);
          } else if (!v.dipped && s.wasDipped) {     // leaving the water     // leaving the water
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
              s.ringTimer = (v.moved ? 0.25 : 0.8) * feel.ring;
              tips.slice(0, 2).forEach(t => emitRipple(t.x, t.y, 0.5 * feel.ripple));
            }
          }
        });
        for (const id of handVisualStates.keys()) {
          if (!activeIds.has(id)) handVisualStates.delete(id);
        }

        droplets.forEach(d => {
          d.x += d.vx * dt;
          d.y += (d.vy ?? 0) * dt;       // splash droplets also travel in y
          d.h += d.vh * dt;
          d.vh -= 650 * dt;
          if (d.h < 0) {
            d.landed = true;
            // Hand-removal droplets have no `ripple` field, so they still always ripple
            if (d.ripple ?? true) emitRipple(d.x, d.y, d.rippleIntensity ?? 0.35);
          }
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
          intensity: intensity * config.rippleForceMultiplier,
          depth: waterDepthAt(px, py)
        });

        if (activeRipplesList.length > MAX_RIPPLES) {
          activeRipplesList.shift();
        }
      }

      function waterDepthAt(px, py) {
        const W = window.innerWidth, H = window.innerHeight, aspect = W / H;
        const x = (px / W - 0.5) * aspect;
        const y = 0.5 - py / H;
        const wobble = 0.05 * Math.sin(x * 5 + 1.3 * Math.sin(y * 3)) + 0.04 * Math.sin(y * 7 + x * 2);
        const qx = Math.abs(x) / (aspect * 0.5), qy = Math.abs(y) / 0.5;
        const r = Math.cbrt(qx ** 3 + qy ** 3) + wobble;
        const t = Math.min(Math.max((r - 0.2) / 0.8, 0), 1);
        return 1 - t * t * (3 - 2 * t);
      }

      function handDepthFeel(x, y) {
        const d = waterDepthAt(x, y);
        return {
          depth: d,
          ripple: 0.55 + 0.9 * d,           // ring strength: small in shallows, heavy in deep
          spray: 1.7 - 1.1 * d,             // droplet amount: lots in shallows, few in deep
          wake: 0.4 + 1.4 * d,              // strength of the travelling wave ahead of the hand
          sprayThreshold: 0.55 + 0.65 * d,  // multiplies SPLASH_MIN_SPEED: shallows splash sooner
          wakeThreshold: 1.35 - 0.85 * d,   // multiplies SPLASH_MIN_SPEED: deep builds wakes sooner
          ring: 0.6 + 0.8 * d               // resting-ring interval: quick in shallows, slow in deep
        };
      }

      // ---- Splash tuning ----
      const SPLASH_MIN_SPEED = 800;       // px/s below this: ripples only, no splash
      const SPLASH_FULL_SPEED = 2600;     // px/s at which the splash is at full strength
      const SPLASH_COOLDOWN = 0.06;       // seconds between droplet bursts per visitor
      const SPLASH_WAVE_COOLDOWN = 0.2;   // seconds between directional waves per visitor
      const SPLASH_MAX_DROPLETS = 500;
      const SPLASH_RIPPLE_CHANCE = 0.12;  // fraction of droplets that ripple on landing

      function splashLevel(speed) {
        return Math.max(0, Math.min((speed - SPLASH_MIN_SPEED) / (SPLASH_FULL_SPEED - SPLASH_MIN_SPEED), 1));
      }

      // Droplets from several points (the whole hand, not just the index tip)
      function emitSplash(points, speed, dirX = 0, dirY = 0, power = 1) {
        const level = splashLevel(speed);
        const strength = (0.4 + 1.6 * level) * power;
        const total = 6 + 24 * level * power;
        const perPoint = Math.max(1, Math.round(total / points.length));
        const hasDir = Math.hypot(dirX, dirY) > 1;
        const heading = hasDir ? Math.atan2(dirY, dirX) : 0;

        points.forEach(p => {
          for (let i = 0; i < perPoint; i++) {
            // Moving: spray forward in a cone. Stationary: spray outward in a ring.
            const angle = hasDir
              ? heading + (Math.random() - 0.5) * 1.6
              : Math.random() * Math.PI * 2;
            const v = (60 + Math.random() * 180) * (0.5 + strength * 0.6);

            droplets.push({
              x: p.x + (Math.random() - 0.5) * 10,
              y: p.y + (Math.random() - 0.5) * 10,
              vx: Math.cos(angle) * v,
              vy: Math.sin(angle) * v,
              h: 2 + Math.random() * 6,
              vh: (90 + Math.random() * 160) * (0.6 + strength * 0.4),
              r: 1.2 + Math.random() * 1.6 * (0.7 + strength * 0.3),
              ripple: Math.random() < SPLASH_RIPPLE_CHANCE,
              rippleIntensity: 0.25
            });
          }
        });

        if (droplets.length > SPLASH_MAX_DROPLETS) {
          droplets.splice(0, droplets.length - SPLASH_MAX_DROPLETS);
        }
      }

      // A small wave that travels in the direction of the disturbance
      function emitSplashWave(px, py, dirX, dirY, intensity) {
        const len = Math.hypot(dirX, dirY);
        if (len < 0.001) return;
        const aspect = window.innerWidth / window.innerHeight;
        splashWaves.push({
          x: (px / window.innerWidth - 0.5) * aspect,
          y: 0.5 - py / window.innerHeight,
          dx: dirX / len,
          dy: -dirY / len,            // screen y points down, shader y points up
          age: 0,
          intensity: intensity * config.rippleForceMultiplier
        });
        if (splashWaves.length > MAX_SPLASH_WAVES) splashWaves.shift();
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
        // Directional splash waves
        for (let i = 0; i < MAX_SPLASH_WAVES; i++) {
          if (i < splashWaves.length) {
            const w = splashWaves[i];
            w.age += dt;
            splashWaveData[i * 4 + 0] = w.x;
            splashWaveData[i * 4 + 1] = w.y;
            splashWaveData[i * 4 + 2] = w.age;
            splashWaveData[i * 4 + 3] = w.intensity;
            splashDirData[i * 4 + 0] = w.dx;
            splashDirData[i * 4 + 1] = w.dy;
          } else {
            splashWaveData[i * 4 + 2] = -1.0;
          }
        }
        splashWaves = splashWaves.filter(w => w.age <= SPLASH_WAVE_LIFE);
      }

      function handleVisitorMove(visitor, dt) {
      const previous = visitorMotionStates.get(visitor.id);
      const dx = previous ? visitor.x - previous.x : 0;
      const dy = previous ? visitor.y - previous.y : 0;
      const distance = Math.hypot(dx, dy);
      const speed = Math.max(visitor.speed, distance);   // still drives ripples/startle

      // Real velocity in px/s, smoothed so 30fps camera updates don't flicker
      const safeDt = Math.max(dt, 0.001);
      const blend = Math.min(1, dt * 12);
      const vx = previous ? previous.vx + (dx / safeDt - previous.vx) * blend : 0;
      const vy = previous ? previous.vy + (dy / safeDt - previous.vy) * blend : 0;
      const velocity = Math.hypot(vx, vy);
      const nowSec = performance.now() / 1000;
      const state = {
        x: visitor.x,
        y: visitor.y,
        vx,
        vy,
        lastSplash: previous?.lastSplash ?? 0,
        lastWave: previous?.lastWave ?? 0
      };
      visitorMotionStates.set(visitor.id, state);

      const hasHandLandmarks = visitor.landmarks?.length >= 21;
      visitorDipStates.set(visitor.id, Boolean(visitor.dipped));

      const feel = handDepthFeel(visitor.x, visitor.y);
      const touchingWater = !hasHandLandmarks || visitor.dipped;

      // Spray: shallow water splashes at gentle speeds, deep water needs a harder slap
      if (touchingWater && velocity > SPLASH_MIN_SPEED * feel.sprayThreshold &&
          nowSec - state.lastSplash > SPLASH_COOLDOWN) {
        state.lastSplash = nowSec;
        emitSplash(getVisitorFishSpots(visitor), velocity, vx, vy, feel.spray);
      }

      // Wake: deep water is pushed into a big travelling wave even at moderate speed
      if (touchingWater && velocity > SPLASH_MIN_SPEED * feel.wakeThreshold &&
          nowSec - state.lastWave > SPLASH_WAVE_COOLDOWN) {
        state.lastWave = nowSec;
        const points = getVisitorFishSpots(visitor);
        const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
        const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
        emitSplashWave(cx, cy, vx, vy, (1.5 + 2.0 * splashLevel(velocity)) * feel.wake);
      }

      if (touchingWater) {
        touchLilyPads(visitor, vx, vy, velocity, dt);
        spookFrogs(visitor, velocity);
      }

      if (hasHandLandmarks && visitor.dipped && visitor.moved && speed > 1.5) {
        emitHandOutlineRipples(visitor, Math.min(speed * 0.08, 1.2) * feel.ripple);
      } else if (!hasHandLandmarks && visitor.moved && speed > 1.5) {
        emitRipple(visitor.x, visitor.y, Math.min(speed * 0.08, 1.2) * feel.ripple);
      }

      if (!visitor.moved) return;

      if (speed > 24) {
        triggerStartle(visitor.x, visitor.y, !hasHandLandmarks);
        playWaterSound('splash', 0.25);
      }
    }

      function handlePointerAction(px, py) {
        if (config.interactionMode === 'ripple') {
          const feel = handDepthFeel(px, py);
          emitRipple(px, py, 2.2 * feel.ripple);
          emitSplash([{ x: px, y: py }], 1800, 0, 0, 1.2 * feel.spray);
          playWaterSound('plop', 0.4);
          bumpLilyPadsAt(px, py);
        } else if (config.interactionMode === 'food') {
          dropFoodPellet(px, py);
          playWaterSound('plop', 0.3);
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

      const LILY_PALETTES = [
        { center: '#6fae78', mid: '#3f7c52', edge: '#2a5c3b' }, // fresh
        { center: '#4f865c', mid: '#347247', edge: '#245535' }, // classic
        { center: '#86a463', mid: '#5d8244', edge: '#436337' }, // olive
        { center: '#52978a', mid: '#367868', edge: '#255a4e' }  // teal
      ];

      function pickLilyRadius() {
        const roll = Math.random();
        if (roll < 0.2) return 16 + Math.random() * 11;   // small
        if (roll < 0.7) return 34 + Math.random() * 16;   // medium
        return 56 + Math.random() * 28;                   // large
      }

      function createLilyPad(position, radius) {
        const small = radius < 30;
        const large = radius >= 56;

        // Shape: full round, thin slit, or wide notch
        const shapeRoll = Math.random();
        let notchHalf;
        if (small) notchHalf = shapeRoll < 0.85 ? 0 : 0.05;
        else if (shapeRoll < 0.35) notchHalf = 0;
        else if (shapeRoll < 0.6) notchHalf = 0.04 + Math.random() * 0.05;
        else notchHalf = 0.28 + Math.random() * 0.18;

        const age = small ? Math.random() * 0.25 : Math.random() * (large ? 1 : 0.75);
        const notchAngle = Math.random() * Math.PI * 2;

        const bites = [];
        if (age > 0.45) {
          const n = Math.floor(Math.random() * 3);
          for (let i = 0; i < n; i++) {
            bites.push({
              angle: Math.random() * Math.PI * 2,
              depth: 0.06 + Math.random() * 0.07,
              width: 0.12 + Math.random() * 0.1
            });
          }
        }

        let hole = null;
        if (age > 0.6 && !small && Math.random() < 0.5) {
          const a = Math.random() * Math.PI * 2;
          const d = radius * (0.3 + Math.random() * 0.3);
          hole = { x: Math.cos(a) * d, y: Math.sin(a) * d, r: radius * (0.04 + Math.random() * 0.04) };
        }

        const spots = [];
        const spotCount = small ? 0 : Math.floor(Math.random() * 4);
        for (let i = 0; i < spotCount; i++) {
          const a = Math.random() * Math.PI * 2;
          const d = Math.random() * radius * 0.65;
          spots.push({
            x: Math.cos(a) * d, y: Math.sin(a) * d,
            rx: radius * (0.08 + Math.random() * 0.12),
            ry: radius * (0.05 + Math.random() * 0.08),
            rot: Math.random() * Math.PI
          });
        }

        let dew = null;
        if (Math.random() < 0.45) {
          const a = Math.random() * Math.PI * 2;
          const d = Math.random() * radius * 0.55;
          dew = { x: Math.cos(a) * d, y: Math.sin(a) * d, r: 1.6 + Math.random() * 1.6 };
        }

        let flower = null;
        if (!small && Math.random() < (large ? 0.55 : 0.4)) {
          const typeRoll = Math.random();
          const a = notchAngle + Math.PI + (Math.random() - 0.5) * 1.2;
          const d = radius * (0.18 + Math.random() * 0.28);
          flower = {
            type: typeRoll < 0.5 ? 'white' : typeRoll < 0.85 ? 'pink' : 'bud',
            x: Math.cos(a) * d,
            y: Math.sin(a) * d,
            rot: Math.random() * Math.PI * 2,
            phase: Math.random() * Math.PI * 2
          };
        }

        return {
          x: position.x,
          y: position.y,
          homeX: position.x,          // fixed anchor the pad floats around
          homeY: position.y,
          ox: 0, oy: 0,               // ripple-driven offset from home
          vx: 0, vy: 0,               // offset velocity
          rotOffset: 0, vRot: 0,      // ripple-driven spin
          heave: 0,                   // smoothed wave height under the pad
          load: 0, loadSmooth: 0,     // frog weight (0..1)
          bounce: 0, bounceV: 0,      // landing/jump-off bob
          tiltX: 0, tiltY: 0,         // highlight shift from motion
          hvx: 0, hvy: 0,             // slide velocity of the pad's home (px/s)
          spin: 0,                    // free spin velocity (rad/s)
          lastTouch: -10,             // last time a hand/pointer touched it
          lastBump: -10,              // last pad-vs-pad or koi bump
          flowerOpen: 1,              // 0 = closed, 1 = fully open
          phase: Math.random() * Math.PI * 2,
          spinBias: (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random() * 0.5),
          radius,
          agility: Math.max(0.65, Math.min(1.7, 48 / radius)),   // small = lighter = livelier
          rotation: Math.random() * Math.PI * 2,
          notchAngle,
          notchHalf,
          squash: 0.9 + Math.random() * 0.1,
          age,
          bites,
          hole,
          spots,
          dew,
          flower,
          hasFlower: Boolean(flower),
          veinCount: 9 + Math.floor(Math.random() * 6),
          edgeAmp: 0.012 + Math.random() * 0.016,
          edgeFreqA: 3 + Math.floor(Math.random() * 3),
          edgeFreqB: 7 + Math.floor(Math.random() * 4),
          palette: LILY_PALETTES[small
            ? (Math.random() < 0.5 ? 0 : 2)
            : Math.floor(Math.random() * LILY_PALETTES.length)]
        };
      }

      function initLilyPads() {
        lilyPads = [];
        const count = Math.min(10, Math.floor((window.innerWidth * window.innerHeight) / 90000));
        const minGap = 24;
        const maxAttemptsPerPad = 80;

        // Place big pads first so they pack better
        const radii = Array.from({ length: count }, pickLilyRadius).sort((a, b) => b - a);

        radii.forEach(radius => {
          let position = null;

          for (let attempt = 0; attempt < maxAttemptsPerPad; attempt++) {
            const marginX = Math.min(radius + minGap, window.innerWidth / 2);
            const marginY = Math.min(radius + minGap, window.innerHeight / 2);
            const x = marginX + Math.random() * (window.innerWidth - marginX * 2);
            const y = marginY + Math.random() * (window.innerHeight - marginY * 2);
            const overlaps = lilyPads.some(pad => {
              const gap = (pad.radius < 30 || radius < 30) ? 10 : minGap;  // small pads may sit closer
              return Math.hypot(pad.x - x, pad.y - y) < pad.radius + radius + gap;
            });
            if (!overlaps) { position = { x, y }; break; }
          }

          if (position) lilyPads.push(createLilyPad(position, radius));
        });
      }

      // ---- Lily pad floating physics (tweak these) ----
      const LILY_INFLUENCE_SCALE = 1.35; // pad's ripple boundary = radius * this
      const LILY_PUSH = 650;             // how hard rings shove the pad (px/s²)
      const LILY_SPIN = 3.0;             // how much rings twist the pad
      const LILY_SPRING = 7;             // pull back toward home
      const LILY_DAMPING = 2.6;          // lower = bouncier
      const LILY_MAX_DRIFT = 14;         // max px a ripple can move a pad from home
      const LILY_HEAVE_SCALE = 0.06;     // pad swells as a wave passes under it
      // ---- Lily pad interaction tuning ----
      const LILY_SLIDE_FRICTION = 2.4;   // how fast a shoved pad stops sliding (1/s)
      const LILY_SPIN_FRICTION = 1.6;    // how fast a flicked pad stops spinning (1/s)
      const LILY_MAX_SLIDE_SPEED = 260;  // top slide speed (px/s), scaled by pad agility
      const LILY_TOUCH_ACCEL = 900;      // how hard a hand in the water shoves a pad (px/s²)

      // Hand / pointer pushing pads around while it is in the water
      function touchLilyPads(visitor, vx, vy, velocity, dt) {
        if (!config.enableLilies || lilyPads.length === 0) return;
        const nowSec = performance.now() / 1000;
        const points = getVisitorFishSpots(visitor);
        const speedFactor = Math.min(velocity / 2500, 1);
        const moving = velocity > 25;

        lilyPads.forEach(pad => {
          let totalWeight = 0, cx = 0, cy = 0;
          points.forEach(p => {
            const distance = Math.hypot(p.x - pad.x, p.y - pad.y);
            const reach = 20;
            if (distance >= pad.radius + reach) return;
            const weight = Math.min(1, (pad.radius + reach - distance) / reach);
            totalWeight += weight;
            cx += p.x * weight;
            cy += p.y * weight;
          });
          if (!totalWeight) return;
          cx /= totalWeight;
          cy /= totalWeight;

          // Moving hands shove along their motion; resting hands nudge outward
          let dirX, dirY;
          if (moving) {
            dirX = vx / velocity; dirY = vy / velocity;
          } else {
            const d = Math.hypot(pad.x - cx, pad.y - cy) || 1;
            dirX = (pad.x - cx) / d; dirY = (pad.y - cy) / d;
          }
          const power = moving ? 0.55 + speedFactor * 1.45 : 0.16;
          const contact = Math.min(1, totalWeight / 2);
          const accel = LILY_TOUCH_ACCEL * power * contact * pad.agility;
          pad.hvx += dirX * accel * dt;
          pad.hvy += dirY * accel * dt;

          // Off-centre pushes twist the pad
          const torque = ((cx - pad.x) * dirY - (cy - pad.y) * dirX) / pad.radius;
          pad.spin += torque * power * 4 * dt * pad.agility;

          // First contact: the pad dips, and a fast hand throws a little spray
          if (nowSec - pad.lastTouch > 0.3) {
            pad.bounceV -= 1.2 + speedFactor * 2;
            if (moving && speedFactor > 0.25) {
              emitSplash([{ x: cx, y: cy }], velocity, vx, vy, 0.6);
            }
          }
          pad.lastTouch = nowSec;
        });
      }

      // Click / pinch on a pad: it bobs, scoots away from the touch and twirls
      function bumpLilyPadsAt(px, py) {
        if (!config.enableLilies) return;
        lilyPads.forEach(pad => {
          const dx = pad.x - px, dy = pad.y - py;
          const d = Math.hypot(dx, dy);
          if (d > pad.radius * 0.95) return;
          const nx = d > 1 ? dx / d : 0;
          const ny = d > 1 ? dy / d : 0;
          pad.bounceV -= 3.0;
          pad.hvx += nx * 110 * pad.agility;
          pad.hvy += ny * 110 * pad.agility;
          pad.spin += pad.spinBias * 1.6 * pad.agility;
        });
      }

      // A fast hand near a perched frog scares it off the pad, away from the hand
      function spookFrogs(visitor, velocity) {
        if (velocity < 1200) return;
        frogs.forEach(frog => {
          if (frog.state !== 'perching') return;
          if (Math.hypot(frog.x - visitor.x, frog.y - visitor.y) > 120) return;
          frog.exitSide = visitor.x < frog.x ? 1 : -1;
          frog.waitTimer = 0;
        });
      }

      // Pads that drift into each other bump apart (lighter pad moves more)
      function resolveLilyPadCollisions(nowSec) {
        for (let i = 0; i < lilyPads.length; i++) {
          for (let j = i + 1; j < lilyPads.length; j++) {
            const a = lilyPads[i], b = lilyPads[j];
            const dx = b.x - a.x, dy = b.y - a.y;
            const dist = Math.hypot(dx, dy) || 0.001;
            const minDist = a.radius + b.radius + 3;
            if (dist >= minDist) continue;

            const nx = dx / dist, ny = dy / dist;
            const overlap = minDist - dist;
            const ma = a.radius * a.radius, mb = b.radius * b.radius;
            const wa = mb / (ma + mb), wb = ma / (ma + mb);

            a.homeX -= nx * overlap * wa;
            a.homeY -= ny * overlap * wa;
            b.homeX += nx * overlap * wb;
            b.homeY += ny * overlap * wb;

            const rel = (b.hvx - a.hvx) * nx + (b.hvy - a.hvy) * ny;
            if (rel < 0) {
              const j2 = -1.4 * rel;
              a.hvx -= nx * j2 * wa; a.hvy -= ny * j2 * wa;
              b.hvx += nx * j2 * wb; b.hvy += ny * j2 * wb;

              if (-rel > 25 && nowSec - Math.max(a.lastBump, b.lastBump) > 0.6) {
                a.lastBump = b.lastBump = nowSec;
                a.bounceV -= 0.8; b.bounceV -= 0.8;
                a.spin -= 0.5 * wa; b.spin += 0.5 * wb;
                emitRipple((a.x + b.x) / 2, (a.y + b.y) / 2, 0.25);
              }
            }
          }
        }
      }

      function updateLilyPads(dt) {
        if (!config.enableLilies || lilyPads.length === 0) return;

        const step = Math.min(dt, 0.05);
        const nowSec = performance.now() / 1000;
        const t = nowSec;
        const W = window.innerWidth;
        const H = window.innerHeight;
        const aspect = W / H;
        const ringWidthSq = 0.025 * 0.025; // same ring width as the water shader
        const flow = 0.35 + config.flowSpeed * 0.65;
        // Lilies close up at night and half-close at twilight
        const flowerTarget = config.theme === 'night' ? 0.05 : config.theme === 'twilight' ? 0.6 : 1;

        resolveLilyPadCollisions(nowSec);

        lilyPads.forEach(pad => {
          const px = (pad.x / W - 0.5) * aspect;
          const py = 0.5 - pad.y / H;
          const boundaryUv = (pad.radius * LILY_INFLUENCE_SCALE) / H;

          let ax = 0, ay = 0, torque = 0, wave = 0;

          for (const r of activeRipplesList) {
            if (r.age <= 0 || r.age > 3.5) continue;

            const dx = px - r.x;
            const dy = py - r.y;
            const dist = Math.hypot(dx, dy);
            const waveRadius = r.age * 0.27 * (0.55 + 0.45 * r.depth);
            const gap = Math.abs(dist - waveRadius);
            const damp = r.intensity * Math.exp(-r.age * (1.9 - 0.8 * r.depth)) * Math.exp(-dist * 2.4);

            const reach = Math.max(0, gap - boundaryUv);
            const push = damp * Math.exp((-2 * reach * reach) / ringWidthSq);
            if (push > 0.002 && dist > 1e-4) {
              ax += (dx / dist) * push * LILY_PUSH;
              ay += (-dy / dist) * push * LILY_PUSH;
              torque += push * pad.spinBias * LILY_SPIN;
            }

            wave += Math.sin((dist - waveRadius) * 45) * damp *
              Math.exp((-2 * gap * gap) / ringWidthSq);
          }

          // Koi brushing past underneath nudge the pad along their heading
          fishes.forEach(fish => {
            const d = Math.hypot(fish.x - pad.x, fish.y - pad.y);
            if (d > pad.radius + fish.length * 0.4) return;
            const fishSpeed = fish.speed * 60; // px/frame -> px/s
            if (fishSpeed < 50) return;
            const hx = Math.cos(fish.angle), hy = Math.sin(fish.angle);
            const nx = (pad.x - fish.x) / (d || 1), ny = (pad.y - fish.y) / (d || 1);
            const k = Math.min(fishSpeed / 180, 1.5) * 70 * pad.agility;
            pad.hvx += (hx * 0.7 + nx * 0.3) * k * step;
            pad.hvy += (hy * 0.7 + ny * 0.3) * k * step;
            pad.spin += (((fish.x - pad.x) * hy - (fish.y - pad.y) * hx) / pad.radius) * 0.5 * step * pad.agility;
            if (nowSec - (pad.lastFishBump ?? -10) > 1.5) {
              pad.lastFishBump = nowSec;
              pad.bounceV -= 0.9;
              emitRipple(fish.x, fish.y, 0.22);
            }
          });

          // Small pads are light and lively, big pads are sluggish
          ax *= pad.agility;
          ay *= pad.agility;
          torque *= pad.agility;
          const damping = LILY_DAMPING * (1.15 - 0.25 * pad.agility);
          const maxDrift = LILY_MAX_DRIFT * pad.agility;

          pad.vx += (ax - LILY_SPRING * pad.ox - damping * pad.vx) * step;
          pad.vy += (ay - LILY_SPRING * pad.oy - damping * pad.vy) * step;
          pad.ox += pad.vx * step;
          pad.oy += pad.vy * step;

          const drift = Math.hypot(pad.ox, pad.oy);
          if (drift > maxDrift) {
            const k = maxDrift / drift;
            pad.ox *= k;
            pad.oy *= k;
          }

          // Shoved pads actually slide: the home point itself moves, then coasts to a stop
          const slideCap = LILY_MAX_SLIDE_SPEED * pad.agility;
          const slideSpeed = Math.hypot(pad.hvx, pad.hvy);
          if (slideSpeed > slideCap) {
            pad.hvx *= slideCap / slideSpeed;
            pad.hvy *= slideCap / slideSpeed;
          }
          pad.homeX += pad.hvx * step;
          pad.homeY += pad.hvy * step;
          const friction = Math.exp(-LILY_SLIDE_FRICTION * step);
          pad.hvx *= friction;
          pad.hvy *= friction;

          // Soft walls: pads bounce gently off the screen edges
          const mx = Math.min(pad.radius * 0.6, W / 2);
          const my = Math.min(pad.radius * 0.6, H / 2);
          if (pad.homeX < mx) { pad.homeX = mx; pad.hvx = Math.abs(pad.hvx) * 0.4; }
          else if (pad.homeX > W - mx) { pad.homeX = W - mx; pad.hvx = -Math.abs(pad.hvx) * 0.4; }
          if (pad.homeY < my) { pad.homeY = my; pad.hvy = Math.abs(pad.hvy) * 0.4; }
          else if (pad.homeY > H - my) { pad.homeY = H - my; pad.hvy = -Math.abs(pad.hvy) * 0.4; }

          // Free spin from flicks, on top of the ripple-driven wobble
          pad.spin *= Math.exp(-LILY_SPIN_FRICTION * step);
          pad.rotation += pad.spin * step;

          pad.vRot += (torque - 9 * pad.rotOffset - 3 * pad.vRot) * step;
          pad.rotOffset = Math.max(-0.35, Math.min(0.35, pad.rotOffset + pad.vRot * step));

          const targetHeave = Math.max(-1, Math.min(1, wave));
          pad.heave += (targetHeave - pad.heave) * Math.min(1, step * 14);

          // Frog weight: pad settles lower while a frog sits on it
          pad.loadSmooth += (pad.load - pad.loadSmooth) * Math.min(1, step * 6);
          pad.load = 0; // the frog loop sets it again each frame

          // Landing / jump-off bob (damped spring)
          pad.bounceV += (-60 * pad.bounce - 5 * pad.bounceV) * step;
          pad.bounce += pad.bounceV * step;

          // Highlight shifts as the pad tilts with its motion (including slides)
          const tx = Math.max(-0.3, Math.min(0.3, (pad.vx + pad.hvx) / 90));
          const ty = Math.max(-0.3, Math.min(0.3, (pad.vy + pad.hvy) / 90));
          pad.tiltX += (tx - pad.tiltX) * Math.min(1, step * 5);
          pad.tiltY += (ty - pad.tiltY) * Math.min(1, step * 5);

          // Flowers open and close with the time of day
          pad.flowerOpen += (flowerTarget - pad.flowerOpen) * Math.min(1, step * 0.8);

          // Idle floating plus a slow wander with the current
          const idleX = (Math.sin(t * 0.55 + pad.phase) * 2.2 +
                         Math.sin(t * 0.23 + pad.phase * 1.7) * 1.5) * pad.agility +
                        Math.sin(t * 0.11 + pad.phase * 2.3) * 5 * flow * pad.agility;
          const idleY = (Math.cos(t * 0.47 + pad.phase * 1.3) * 2.0 +
                         Math.sin(t * 0.29 + pad.phase * 0.6) * 1.2) * pad.agility +
                        Math.cos(t * 0.09 + pad.phase * 1.9) * 4 * flow * pad.agility;
          pad.idleRot = Math.sin(t * 0.31 + pad.phase) * 0.035 * pad.agility;
          pad.rotation += pad.spinBias * 0.015 * pad.agility * step;   // very slow turn

          pad.x = pad.homeX + pad.ox + idleX;
          pad.y = pad.homeY + pad.oy + idleY;
        });
      }

      function lilyEdgeRadius(pad, a, t) {
        let k = 1 +
          pad.edgeAmp * Math.sin(a * pad.edgeFreqA + pad.phase + t * 0.5) +
          pad.edgeAmp * 0.6 * Math.sin(a * pad.edgeFreqB - pad.phase * 1.3 - t * 0.4) +
          Math.abs(pad.heave) * 0.012 * Math.sin(a * 5 + t * 2.2);
        for (const bite of pad.bites) {
          const d = Math.atan2(Math.sin(a - bite.angle), Math.cos(a - bite.angle));
          k -= bite.depth * Math.exp(-(d * d) / (bite.width * bite.width));
        }
        return pad.radius * k;
      }

      function traceLilyPath(pad, t) {
        const path = new Path2D();
        const half = pad.notchHalf;
        const start = pad.notchAngle + half;
        const end = pad.notchAngle + Math.PI * 2 - half;
        const steps = Math.max(28, Math.round(pad.radius * 0.8));

        if (half > 0) path.moveTo(0, 0);
        for (let i = 0; i <= steps; i++) {
          const a = start + (end - start) * (i / steps);
          const r = lilyEdgeRadius(pad, a, t);
          const x = Math.cos(a) * r;
          const y = Math.sin(a) * r * pad.squash;
          if (i === 0 && half === 0) path.moveTo(x, y);
          else path.lineTo(x, y);
        }
        path.closePath();

        if (pad.hole) {
          path.moveTo(pad.hole.x + pad.hole.r, pad.hole.y);
          path.arc(pad.hole.x, pad.hole.y, pad.hole.r, 0, Math.PI * 2);
        }
        return path;
      }

      function drawLilyFlower(ctx, pad, t) {
        const f = pad.flower;
        if (!f) return;
        const open = pad.flowerOpen ?? 1;
        const u = Math.max(6, Math.min(15, pad.radius * 0.18)) *
          (1 + 0.025 * Math.sin(t * 0.8 + f.phase));
        const colors = f.type === 'pink'
          ? { outer: '#f0a3c0', inner: '#fad2e1' }
          : { outer: '#f1f6ee', inner: '#ffffff' };

        ctx.save();
        ctx.translate(f.x, f.y);
        ctx.rotate(f.rot);

        ctx.fillStyle = 'rgba(2, 12, 18, 0.18)';
        ctx.beginPath();
        ctx.ellipse(1.5, 2.5, u * 1.5, u * 1.3, 0, 0, Math.PI * 2);
        ctx.fill();

        if (f.type === 'bud' || open < 0.12) {
          ctx.fillStyle = '#3b7a4b';
          [-1, 1].forEach(s => {
            ctx.beginPath();
            ctx.ellipse(s * u * 0.3, 0, u * 0.3, u * 0.85, s * 0.35, 0, Math.PI * 2);
            ctx.fill();
          });
          ctx.fillStyle = f.type === 'white' ? '#f4f8f1' : '#f6c4d5';
          ctx.beginPath();
          ctx.ellipse(0, -u * 0.1, u * 0.38, u * 0.95, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
          ctx.beginPath();
          ctx.ellipse(-u * 0.1, -u * 0.3, u * 0.12, u * 0.4, 0, 0, Math.PI * 2);
          ctx.fill();
        } else {
          // Petals spread and lengthen as the flower opens
          const size = 0.4 + 0.6 * open;
          const spread = 0.25 + 0.75 * open;
          ctx.strokeStyle = 'rgba(60, 40, 60, 0.12)';
          ctx.lineWidth = 0.6;
          ctx.fillStyle = colors.outer;
          for (let i = 0; i < 8; i++) {
            const a = (i / 8) * Math.PI * 2;
            ctx.beginPath();
            ctx.ellipse(Math.cos(a) * u * 0.8 * spread, Math.sin(a) * u * 0.8 * spread,
              u * 1.05 * size, u * 0.4 * (0.7 + 0.3 * open), a, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
          ctx.fillStyle = colors.inner;
          for (let i = 0; i < 6; i++) {
            const a = ((i + 0.5) / 6) * Math.PI * 2;
            ctx.beginPath();
            ctx.ellipse(Math.cos(a) * u * 0.5 * spread, Math.sin(a) * u * 0.5 * spread,
              u * 0.78 * size, u * 0.32, a, 0, Math.PI * 2);
            ctx.fill();
          }
          if (open > 0.35) {
            ctx.fillStyle = '#f6b81a';
            ctx.beginPath();
            ctx.arc(0, 0, u * 0.42 * (0.6 + 0.4 * open), 0, Math.PI * 2);
            ctx.fill();
          }
          if (open > 0.6) {
            ctx.fillStyle = '#d98a0a';
            for (let i = 0; i < 8; i++) {
              const a = (i / 8) * Math.PI * 2;
              ctx.beginPath();
              ctx.arc(Math.cos(a) * u * 0.25, Math.sin(a) * u * 0.25, u * 0.07, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
        ctx.restore();
      }

      function drawLilyPad(ctx, pad, t) {
        const R = pad.radius;
        const rot = pad.rotation + pad.rotOffset + (pad.idleRot ?? 0);
        const scale = 1 + pad.heave * LILY_HEAVE_SCALE + pad.bounce * 0.09 - pad.loadSmooth * 0.035;
        const sink = pad.loadSmooth;
        const path = traceLilyPath(pad, t);
        const rule = pad.hole ? 'evenodd' : 'nonzero';

        ctx.save();
        ctx.translate(pad.x, pad.y);
        ctx.rotate(rot);
        ctx.scale(scale, scale);

        // Water meniscus ring around the pad
        const lap = Math.max(0, 0.06 + 0.035 * Math.sin(t * 1.3 + pad.phase) + sink * 0.05);
        const lapScale = 1.07 + 0.015 * Math.sin(t * 0.9 + pad.phase);
        ctx.strokeStyle = `rgba(200, 240, 245, ${lap.toFixed(3)})`;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.ellipse(0, 0, R * lapScale, R * pad.squash * lapScale, 0, 0, Math.PI * 2);
        ctx.stroke();

        // Light offset in the pad's own rotated space (light comes from top-left)
        const cosR = Math.cos(-rot), sinR = Math.sin(-rot);
        const lx = -0.30 + pad.tiltX, ly = -0.34 + pad.tiltY;
        const hx = (lx * cosR - ly * sinR) * R * 0.55;
        const hy = (lx * sinR + ly * cosR) * R * 0.55;

        const grad = ctx.createRadialGradient(hx * 0.4, hy * 0.4, R * 0.04, 0, 0, R * 1.02);
        grad.addColorStop(0, pad.palette.center);
        grad.addColorStop(0.72, pad.palette.mid);
        grad.addColorStop(1, pad.palette.edge);

        // Body with soft shadow (shadow tightens as the pad sinks under a frog)
        ctx.shadowColor = 'rgba(2, 12, 18, 0.35)';
        ctx.shadowBlur = (9 - 3 * sink) * dpr;
        ctx.shadowOffsetX = (3 - 1.2 * sink) * dpr;
        ctx.shadowOffsetY = (4 - 1.6 * sink) * dpr;
        ctx.fillStyle = grad;
        ctx.fill(path, rule);
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;

        // Surface detail, clipped to the pad
        ctx.save();
        ctx.clip(path, rule);

        ctx.fillStyle = 'rgba(18, 48, 28, 0.14)';
        pad.spots.forEach(s => {
          ctx.beginPath();
          ctx.ellipse(s.x, s.y, s.rx, s.ry, s.rot, 0, Math.PI * 2);
          ctx.fill();
        });

        ctx.strokeStyle = 'rgba(18, 52, 30, 0.2)';
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        const veinSpan = Math.PI * 2 - pad.notchHalf * 2;
        for (let i = 0; i < pad.veinCount; i++) {
          const a = pad.notchAngle + pad.notchHalf + veinSpan * ((i + 0.5) / pad.veinCount);
          ctx.moveTo(Math.cos(a) * R * 0.06, Math.sin(a) * R * 0.06 * pad.squash);
          ctx.lineTo(Math.cos(a) * R * 0.9, Math.sin(a) * R * 0.9 * pad.squash);
        }
        ctx.stroke();

        // Center dimple
        ctx.fillStyle = 'rgba(20, 60, 35, 0.22)';
        ctx.beginPath();
        ctx.arc(0, 0, R * 0.07, 0, Math.PI * 2);
        ctx.fill();

        // Moving sheen
        const gloss = ctx.createRadialGradient(hx, hy, 0, hx, hy, R * 0.75);
        gloss.addColorStop(0, 'rgba(255, 255, 230, 0.16)');
        gloss.addColorStop(1, 'rgba(255, 255, 230, 0)');
        ctx.fillStyle = gloss;
        ctx.fillRect(-R * 1.2, -R * 1.2, R * 2.4, R * 2.4);

        // Older pads: brown stain creeping in from the edge
        if (pad.age > 0.35) {
          ctx.strokeStyle = `rgba(122, 98, 42, ${(pad.age * 0.4).toFixed(3)})`;
          ctx.lineWidth = R * 0.16 * pad.age + 1;
          ctx.stroke(path);
        }
        ctx.restore();

        // Thin wet rim
        ctx.strokeStyle = 'rgba(200, 245, 255, 0.16)';
        ctx.lineWidth = 1.2;
        ctx.stroke(path);

        // Dewdrop
        if (pad.dew) {
          const d = pad.dew;
          ctx.fillStyle = 'rgba(230, 248, 255, 0.5)';
          ctx.beginPath();
          ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
          ctx.beginPath();
          ctx.arc(d.x - d.r * 0.3, d.y - d.r * 0.3, d.r * 0.35, 0, Math.PI * 2);
          ctx.fill();
        }

        drawLilyFlower(ctx, pad, t);
        ctx.restore();
      }

      // Net push of all ripples/waves at a screen point, as a direction-weighted
      // strength (screen space). Used by frogs to sway with the water.
      function getWaterPush(px, py, boundaryPx = 14) {
        const W = window.innerWidth;
        const H = window.innerHeight;
        const aspect = W / H;
        const x = (px / W - 0.5) * aspect;
        const y = 0.5 - py / H;
        const boundaryUv = boundaryPx / H;
        const ringWidthSq = 0.025 * 0.025;
        const OWN_ORIGIN_RADIUS = 0.03; // ignore a ripple born right under the frog
        let ax = 0, ay = 0;

        for (const r of activeRipplesList) {
          if (r.age <= 0 || r.age > 3.5) continue;
          const dx = x - r.x;
          const dy = y - r.y;
          const dist = Math.hypot(dx, dy);
          if (dist < OWN_ORIGIN_RADIUS) continue;

          const waveRadius = r.age * 0.27 * (0.55 + 0.45 * r.depth);
          const gap = Math.abs(dist - waveRadius);
          const damp = r.intensity * Math.exp(-r.age * (1.9 - 0.8 * r.depth)) * Math.exp(-dist * 2.4);
          const reach = Math.max(0, gap - boundaryUv);
          const push = damp * Math.exp((-2 * reach * reach) / ringWidthSq);
          if (push > 0.002) {
            ax += (dx / dist) * push;    // away from the ripple origin
            ay += (-dy / dist) * push;   // screen y is flipped
          }
        }

        // Directional splash waves push along their travel direction
        for (const w of splashWaves) {
          if (w.age <= 0 || w.age > SPLASH_WAVE_LIFE) continue;
          const dist = Math.hypot(x - w.x, y - w.y);
          const gap = Math.abs(dist - w.age * 0.30);
          const damp = w.intensity * Math.exp(-w.age * 1.3) * Math.exp(-dist * 2.0);
          const reach = Math.max(0, gap - boundaryUv);
          const push = damp * Math.exp((-2 * reach * reach) / ringWidthSq);
          if (push > 0.002) {
            ax += w.dx * push;
            ay += -w.dy * push;
          }
        }

        return { ax, ay };
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
          pad.homeX = Math.min(Math.max(pad.homeX * scaleX, pad.radius), Math.max(pad.radius, width - pad.radius));
          pad.homeY = Math.min(Math.max(pad.homeY * scaleY, pad.radius), Math.max(pad.radius, height - pad.radius));
          pad.x = pad.homeX;
          pad.y = pad.homeY;
          pad.ox = pad.oy = pad.vx = pad.vy = 0;
          pad.hvx = pad.hvy = pad.spin = 0;
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

      function renderUnderwaterScene(dt, visitors) {
        // Clear & Draw Pebble Bed Background
        uwCtx.clearRect(0, 0, uwCanvas.width, uwCanvas.height);

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



        uwCtx.restore();

        // Flag Three.js texture for WebGL update
        uwTexture.needsUpdate = true;
      }

      function renderForegroundScene(dt, visitors = []) {
        const width = window.innerWidth;
        const height = window.innerHeight;
        const t = performance.now() / 1000;
        foregroundCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        foregroundCtx.clearRect(0, 0, width, height);

        if (config.enableLilies) {
          lilyPads.forEach(pad => drawLilyPad(foregroundCtx, pad, t));
        }

        frogs.forEach(frog => {
          const prevState = frog.state;
          const push = getWaterPush(frog.x, frog.y);
          frog.applyWaterPush(push.ax, push.ay, dt);
          frog.update(dt, width, height, lilyPads, config.enableLilies, waterDepthAt);

          // The pad reacts to the frog's weight, landing and jump-off
          const pad = frog.targetPad;
          if (pad) {
            if (frog.state === 'perching') pad.load = 1;
            if (prevState === 'hoppingToPad' && frog.state === 'perching') {
              pad.bounceV -= 3.2;
              pad.vx += Math.cos(frog.angle) * 35;
              pad.vy += Math.sin(frog.angle) * 35;
            }
            if (prevState === 'perching' && frog.state === 'hoppingToWater') {
              pad.bounceV -= 2.2;
              pad.vx -= Math.cos(frog.angle) * 45;
              pad.vy -= Math.sin(frog.angle) * 45;
            }
          }

          frog.consumeWaterRippleEvents().forEach(ripple => {
            emitRipple(ripple.x, ripple.y, ripple.intensity ?? 0.18);
          });
          frog.consumeSplashEvents().forEach(splash => {
            emitSplash([{ x: splash.x, y: splash.y }], 1800, 0, 0, splash.power);
            playWaterSound('splash', 0.3);
          });
          frog.draw(foregroundCtx);
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
        requestAnimationFrame(animate);   // moved to the top so one bad frame can't kill the loop

        try {
          const now = performance.now();
          const dt = Math.min(0.1, (now - lastTime) / 1000);
          lastTime = now;

          const inputState = input.update();
          const visitorInputs = inputState.visitors ?? [];
          updateVisitorIdleDetection(visitorInputs, dt);
          assignVisitorTargets();
          visitorInputs.forEach(visitor => {
            handleVisitorMove(visitor, dt);
            if (visitor.action) handlePointerAction(visitor.x, visitor.y);
          });
          updateHandVisuals(visitorInputs, dt);
          updateRipples(dt);
          updateLilyPads(dt);
          renderUnderwaterScene(dt, visitorInputs);
          renderForegroundScene(dt, visitorInputs);

          waterUniforms.uTime.value += dt;
          renderer.render(scene, camera);
        } catch (error) {
          console.error('[pond] frame error:', error);
        }
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
          { id: 'btnModeFood', mode: 'food' }
        ];
        modeButtons.forEach(item => {
          document.getElementById(item.id).addEventListener('click', () => {
            modeButtons.forEach(b => document.getElementById(b.id).classList.remove('active'));
            document.getElementById(item.id).classList.add('active');
            config.interactionMode = item.mode;
          });
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
        document.getElementById('chkLilies').addEventListener('change', (e) => {
          const enabled = e.target.checked;

          if (!enabled) {
            frogs.forEach(frog => frog.disableLilyPads());
          }

          config.enableLilies = enabled;
        });

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
