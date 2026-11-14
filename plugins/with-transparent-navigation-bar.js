const { AndroidConfig, withAndroidStyles } = require("expo/config-plugins");

module.exports = function withTransparentNavigationBar(config) {
  return withAndroidStyles(config, (stylesConfig) => {
    const parent = AndroidConfig.Styles.getAppThemeGroup();
    stylesConfig.modResults = AndroidConfig.Styles.assignStylesValue(
      stylesConfig.modResults,
      {
        add: true,
        parent,
        name: "android:enforceNavigationBarContrast",
        value: "false",
      }
    );
    return stylesConfig;
  });
};
