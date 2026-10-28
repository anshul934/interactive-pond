import * as THREE from "three";
import { createPondSimulation } from "./PondSimulation.js";
import { InputManager } from "./input/InputManager.js";

const canvas = document.getElementById("webglCanvas");
const cameraVideo = document.getElementById("cameraVideo");
const cameraStatus = document.getElementById("cameraStatus");
const cameraButton = document.getElementById("cameraToggleBtn");
const cameraIcon = document.getElementById("cameraToggleIcon");
const input = new InputManager(canvas, cameraVideo, cameraStatus);

createPondSimulation(THREE, input);

cameraButton.addEventListener("click", async () => {
  cameraButton.disabled = true;

  try {
    if (input.cameraEnabled) {
      input.stopCamera();
      cameraStatus.textContent = "Camera off";
      cameraButton.title = "Enable camera input";
      cameraButton.setAttribute("aria-label", "Enable camera input");
      cameraButton.classList.remove("active");
      cameraIcon.className = "fa-solid fa-camera text-sm";
    } else {
      cameraStatus.textContent = "Starting camera...";
      const ready = await input.startCamera();
      if (ready) {
        cameraStatus.textContent = "Camera on";
        cameraButton.title = "Disable camera input";
        cameraButton.setAttribute("aria-label", "Disable camera input");
        cameraButton.classList.add("active");
        cameraIcon.className = "fa-solid fa-camera text-sm text-cyan-300";
      } else {
        const message = input.camera?.statusMessage ?? cameraStatus.textContent;
        cameraStatus.textContent = message;
        cameraButton.title = message;
        cameraButton.setAttribute("aria-label", message);
        cameraButton.classList.remove("active");
        cameraIcon.className = "fa-solid fa-camera text-sm";
      }
    }
  } catch (error) {
    console.error("[App] Camera startup failed:", error);
    const message = `Camera unavailable: ${error.message}`;
    cameraStatus.textContent = message;
    cameraButton.title = message;
    cameraButton.setAttribute("aria-label", message);
    cameraButton.classList.remove("active");
    cameraIcon.className = "fa-solid fa-camera text-sm";
  } finally {
    cameraButton.disabled = false;
  }
});

window.addEventListener("beforeunload", () => {
  input.stopCamera();
});
