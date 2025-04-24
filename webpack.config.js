const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

const rendererConfig = {
    mode: 'development',
    entry: './src/renderer/renderer.ts',
    target: 'web', // Changed to web since we're running in a browser context
    devtool: 'source-map',
    module: {
        rules: [
            {
                test: /\.ts$/,
                use: {
                    loader: 'ts-loader',
                    options: {
                        compilerOptions: {
                            module: 'es2015'
                        }
                    }
                },
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
            path: false,
            fs: false,
            crypto: false,
            stream: false,
            util: false
        }
    },
    output: {
        filename: 'renderer.js',
        path: path.resolve(__dirname, 'dist/renderer'),
        libraryTarget: 'umd'
    }
};

const mainConfig = {
    mode: 'development',
    entry: './src/main/main.ts',
    target: 'electron-main',
    devtool: 'source-map',
    module: {
        rules: [
            {
                test: /\.ts$/,
                use: 'ts-loader',
                exclude: /node_modules/
            }
        ]
    },
    resolve: {
        extensions: ['.ts', '.js']
    },
    output: {
        filename: 'main.js',
        path: path.resolve(__dirname, 'dist/main')
    },
    externals: ['electron']
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

module.exports = [rendererConfig, mainConfig, preloadConfig];