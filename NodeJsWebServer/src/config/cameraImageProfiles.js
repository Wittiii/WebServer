// Complete image-only comparisons. Stream, mounting and timelapse settings
// deliberately have no entries here. The controller validates against the
// controls reported by the connected firmware before publishing one command.
const base = {
  preset: 0, brightness: 0, contrast: 128, saturation: 120, hue: 0,
  gamma: 72, sharpness: 45, denoise: 5, exposure_target: 70,
  awb: true, red_balance: 1000, blue_balance: 1000,
  adaptive_image: true, gain_limit: 15500,
};

const profiles = [
  ["neutral", "Neutral", "Ausgewogene Ausgangsbasis mit automatischem Weißabgleich und moderatem Rauschfilter.", {}],
  ["detail", "Details", "Mehr feine Strukturen; sichtbares Rauschen kann zunehmen.", { denoise: 3, sharpness: 50 }],
  ["quiet", "Ruhig", "Weniger Rauschen und zurückhaltende Nachschärfung; feine Details werden weicher.", { denoise: 7, sharpness: 32, contrast: 124, saturation: 116 }],
  ["low-light", "Wenig Licht", "Hellere Schatten bei wenig Licht; helle Lichtquellen können stärker überstrahlen.", { brightness: 2, contrast: 120, saturation: 112, gamma: 64, sharpness: 32, denoise: 6, exposure_target: 78 }],
  ["highlights", "Helle Lichtquellen", "Niedrigeres Belichtungsziel für Szenen mit Lampen oder Fenstern; dunkle Bereiche können dunkler werden.", { contrast: 120, saturation: 116, gamma: 68, sharpness: 40, exposure_target: 55 }],
  ["reference", "OV5647 Referenz", "Bisherige Standard-Bildwerte zum Vergleich; verwendet ebenfalls die Farbmatrix der installierten Firmware.", { saturation: 128, exposure_target: 80 }],
  ["indoor-fixed", "Innenlicht fest", "Fester Weißabgleich als Versuch gegen den Gelbstich unter dem aktuellen Innenlicht. Bei anderem Licht wieder Neutral wählen.", { awb: false, red_balance: 1150, blue_balance: 2500 }],
].map(([id, label, description, changes]) => Object.freeze({
  id, label, description, settings: Object.freeze({ ...base, ...changes }),
}));

function getCameraImageProfiles(kind) {
  return kind === "esp32-p4"
    ? profiles.map((profile) => ({ ...profile, settings: { ...profile.settings } }))
    : [];
}

module.exports = { getCameraImageProfiles };
