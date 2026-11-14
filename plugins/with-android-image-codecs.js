const { withGradleProperties } = require("expo/config-plugins");

const DISABLED_IMAGE_CODECS = ["expo.gif.enabled", "expo.webp.enabled"];

function applyDisabledImageCodecs(properties) {
  for (const key of DISABLED_IMAGE_CODECS) {
    const existing = properties.find(
      (item) => item.type === "property" && item.key === key
    );

    if (existing) {
      existing.value = "false";
    } else {
      properties.push({ type: "property", key, value: "false" });
    }
  }
}

function withAndroidImageCodecs(config) {
  return withGradleProperties(config, (gradleConfig) => {
    applyDisabledImageCodecs(gradleConfig.modResults);
    return gradleConfig;
  });
}

module.exports = withAndroidImageCodecs;
module.exports.applyDisabledImageCodecs = applyDisabledImageCodecs;
