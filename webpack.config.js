const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

const rendererConfig = {
    mode: 'development',
    entry: './src/renderer/renderer.ts',
    target: 'electron-renderer',
    devtool: 'source-map',
    module: {
        rules: [
            {
                test: /\.ts$/,
                use: 'ts-loader',
                exclude: /node_modules/,
            },
            {
                test: /\.css$/,
                use: ['style-loader', 'css-loader'],
            }
        ],
    },
    plugins: [
        new HtmlWebpackPlugin({
            template: './src/renderer/index.html',
            filename: 'index.html'
        }),
        new CopyWebpackPlugin({
            patterns: [
                {
                    from: './src/renderer/assets',
                    to: 'assets'
                },
                {
                    from: './src/renderer/styles.css',
                    to: 'styles.css'
                }
            ]
        })
    ],
    resolve: {
        extensions: ['.ts', '.js'],
        fallback: {
            "path": require.resolve("path-browserify"),
            "os": require.resolve("os-browserify/browser"),
            "crypto": require.resolve("crypto-browserify")
        }
    },
    output: {
        filename: 'renderer.js',
        path: path.resolve(__dirname, 'dist/renderer')
    }
};

const preloadConfig = {
    mode: 'development',
    entry: './src/preload/preload.ts',
    target: 'electron-preload',
    devtool: 'source-map',
    module: {
        rules: [
            {
                test: /\.ts$/,
                use: 'ts-loader',
                exclude: /node_modules/,
            }
        ]
    },
    resolve: {
        extensions: ['.ts', '.js']
    },
    output: {
        filename: 'preload.js',
        path: path.resolve(__dirname, 'dist/preload')
    }
};

module.exports = [rendererConfig, preloadConfig];