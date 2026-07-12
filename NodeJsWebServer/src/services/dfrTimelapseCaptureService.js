// Backward-compatible exports for deployments that still import the old service name.
const {
  getCameraTimelapseCaptureSnapshot,
  startCameraTimelapseCaptureSupervisor,
} = require("./cameraTimelapseCaptureService");

module.exports = {
  getDfrTimelapseCaptureSnapshot: getCameraTimelapseCaptureSnapshot,
  startDfrTimelapseCaptureSupervisor: startCameraTimelapseCaptureSupervisor,
};
