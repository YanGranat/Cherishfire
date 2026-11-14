module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    plugins: [
      ["inline-import", { extensions: [".sql"] }],
      [
        "module-resolver",
        {
          root: ["."],
          alias: {
            "@": "./src",
            "@app": "./app",
          },
          extensions: [".ts", ".tsx", ".js", ".jsx", ".json"],
        },
      ],
      "react-native-reanimated/plugin", // must be last
    ],
  };
};
