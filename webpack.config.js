const webpack = require("webpack");
const TerserPlugin = require('terser-webpack-plugin');
const frame_realm = require('./build/frame-realm.cjs');
const path = require('node:path');
const rollup_license = require('node:fs').readFileSync(path.join(path.dirname(require.resolve('@rollup/browser')), '..', 'LICENSE.md'), 'utf8');

const pkg = require("./package.json");
const { execSync } = require("child_process");
const git_hash = execSync("git rev-parse --short HEAD").toString().trim();
const git_tag = execSync("git tag -l --contains HEAD").toString().trim();
let version = pkg.version;
if (!git_tag) version += "-dev";

const banner_text = `
ading2210/sandstone - A web proxy using sandboxed iframes 
Copyright (C) 2024 ading2210

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.

Source code: https://github.com/ading2210/sandstone
License: https://github.com/ading2210/sandstone/blob/main/LICENSE
`

const bundles = [
  {
    name: "sandstone_frame",
    dependencies:["sandstone_worker_bundler"],
    entry:"./src/frame/index.mjs",
    output: {
      filename: "sandstone_frame.js",
      library: {
        name: "sandstone_frame",
        type: "var"
      }
    },
    plugins: [
      new webpack.BannerPlugin({banner:frame_realm.header,raw:true,entryOnly:true}),
      new webpack.BannerPlugin({banner:frame_realm.footer,raw:true,entryOnly:true,footer:true})
    ],
    module: {rules:[{resource:/dist[\\/]sandstone_worker_bundler\.js$/,type:'asset/source'}]},
    // Preserve dependency notices inside the standalone runtime, rather than
    // referring to an extra LICENSE.txt file beside the downloaded HTML.
    optimization:{minimizer:[new TerserPlugin({extractComments:false})]},
    mode: "development"
  },
  {
    name: "sandstone",
    dependencies: ["sandstone_frame","sandstone_shared_backend"],
    entry: "./src/host/index.mjs",
    output: {
      filename: "sandstone.js",
      library: {
        name: "sandstone",
        type: "var"
      }
    },
    module: {
      rules: [
        {resource:/libcurl\.wasm$/,type:'asset/inline',generator:{dataUrl:{mimetype:'application/octet-stream'}}},
        {
          resource: /dist[\\/]sandstone_(frame|shared_backend)\.js$/,
          type: "asset/source"
        },
      ],
    },
    mode: "development",
    optimization: {
      minimizer: [
        new TerserPlugin({extractComments: false})
      ],
    },  
    plugins: [
      new webpack.DefinePlugin({
        __VERSION__: JSON.stringify(version),
        __GIT_HASH__: JSON.stringify(git_hash)
      }),
      new webpack.BannerPlugin({banner: banner_text.trim()})
    ]
  },
];

bundles.push({
  name:'sandstone_shared_backend',
  entry:'./src/host/shared_backend.mjs',
  output:{filename:'sandstone_shared_backend.js'},
  optimization:{minimizer:[new TerserPlugin({extractComments:false})]},
  plugins:[
    new webpack.BannerPlugin({banner:banner_text.trim()})
  ],
  mode:'development'
});

bundles.push({
  ...bundles[1],
  name: bundles[1].name + "_es6",
  experiments: {outputModule: true},
  output: {
    filename: "sandstone.mjs",
    library: {
      type: "module"
    }
  }
});

// Embed the compiler as source text. Ordinary documents and acyclic workers
// carry its bytes but only cyclic graphs parse/initialize its JavaScript/WASM.
bundles.unshift({
  name:'sandstone_worker_bundler',
  entry:{main:{import:'./src/frame/worker_bundler.mjs',baseUri:'about:blank'}},
  output:{filename:'sandstone_worker_bundler.js',library:{name:'sandstone_worker_bundler',type:'var'}},
  module:{rules:[{test:/bindings_wasm_bg\.wasm$/,type:'asset/inline'}]},
  optimization:{minimizer:[new TerserPlugin({extractComments:false})]},
  plugins:[new webpack.BannerPlugin({banner:rollup_license,entryOnly:true})],
  mode:'development'
});

module.exports = bundles;
