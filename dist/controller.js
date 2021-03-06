'use strict';

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var path = require('path');
var fs = require('fs');
var installer = require('./installer');
var iri = require('./iri');
var nelson = require('./nelson');
var system = require('./system');
var settings = require('./settings');

var DEFAULT_OPTIONS = {
    targetDir: null,
    maxMessages: 1000,
    onStateChange: function onStateChange(state) {},
    onMessage: function onMessage(messages) {}
};

var Controller = function () {
    function Controller(options) {
        var _this = this;

        _classCallCheck(this, Controller);

        this.opts = Object.assign({}, DEFAULT_OPTIONS, options);
        this.state = {};
        this.messages = {
            iri: [],
            system: [],
            database: [],
            nelson: []
        };
        var targetDir = this.opts.targetDir || path.join(process.cwd(), 'data');
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir);
        }
        this.targetDir = targetDir;
        this.iriInstaller = new installer.iri.IRIInstaller({ targetDir: targetDir });
        this.databaseInstaller = new installer.database.DatabaseInstaller({
            targetDir: targetDir,
            onMessage: function onMessage(message) {
                return _this.message('database', message);
            }
        });
        this.iri = new iri.IRI({
            iriPath: this.iriInstaller.getTargetFileName(),
            dbPath: this.databaseInstaller.targetDir,
            onError: function onError(err) {
                _this.message('iri', 'ERROR: ' + (err ? err.message : ''));
                _this.updateState('iri', { status: 'error', error: err ? err.message : '' });
            },
            onMessage: function onMessage(message) {
                return _this.message('iri', message);
            }
        });
        this.nelson = new nelson.Nelson({
            dataPath: this.databaseInstaller.targetDir,
            onError: function onError(err) {
                _this.message('nelson', 'ERROR: ' + (err ? err.message : ''));
                _this.updateState('nelson', { status: 'error', error: err ? err.message : '' });
            },
            onMessage: function onMessage(message) {
                return _this.message('nelson', message);
            }
        });
        this.system = new system.System({
            onMessage: function onMessage(message) {
                return _this.message('system', message);
            }
        });
        this.settings = new settings.Settings();
        this.state = {
            system: {
                status: 'waiting',
                hasEnoughSpace: false,
                hasEnoughMemory: false,
                hasJavaInstalled: false,
                isSupportedPlatform: false
            },
            iri: {
                status: 'waiting'
            },
            nelson: {
                status: 'waiting'
            },
            database: {
                status: 'waiting'
            }
        };
        this.updater = null;
        this.updateCounter = 0;
        this.updateState = this.updateState.bind(this);
    }

    _createClass(Controller, [{
        key: 'tick',
        value: function tick() {
            var _this2 = this;

            var getNelsonInfo = function getNelsonInfo() {
                if (_this2.state.nelson.status === 'running') {
                    var info = _this2.nelson.getNodeInfo();
                    _this2.updateState('nelson', { info: info });
                    _this2.updateCounter += 1;
                    if (!_this2.updateCounter % 6) {
                        // TODO: add webhook here
                    }
                } else if (_this2.state.nelson.status === 'error') {
                    _this2.message('nelson', 'Service seems down, trying to restart...');
                    setTimeout(function () {
                        return _this2.nelson.stop().then(function () {
                            return _this2.nelson.start();
                        });
                    }, 5000);
                }
            };
            if (this.state.iri.status === 'running') {
                this.iri.getNodeInfo().then(function (info) {
                    _this2.updateState('iri', { info: info });
                    getNelsonInfo();
                }).catch(function (err) {
                    _this2.message('iri', 'Failed getting IRI API update...');
                    _this2.updateState('iri', { status: 'error', error: err.message });
                    getNelsonInfo();
                });
            } else if (this.state.iri.status === 'error') {
                this.message('iri', 'IRI seems down, trying to restart in 5 seconds...');
                this.iri.stop();
                getNelsonInfo();
                setTimeout(function () {
                    return _this2.iri.start();
                }, 5000);
            }
        }
    }, {
        key: 'start',
        value: function start() {
            var _this3 = this;

            return new Promise(function (resolve, reject) {
                _this3.checkSystem().then(function (ready) {
                    if (ready) {
                        Promise.all([_this3.install('iri'), _this3.install('database')]).then(function () {
                            Promise.all([_this3.startIRI(), _this3.startNelson()]).then(function () {
                                _this3.updater = setInterval(function () {
                                    return _this3.tick();
                                }, 5000);
                                resolve();
                            }).catch(function (err) {
                                // Start failed
                                reject(err);
                            });
                        }).catch(function (err) {
                            // Installation failed
                            _this3.message('iri', 'Installation failed');
                            _this3.message('database', 'Installation failed');
                            reject(err);
                        });
                    }
                });
            });
        }
    }, {
        key: 'stop',
        value: function stop() {
            var _this4 = this;

            if (this.updater) {
                clearInterval(this.updater);
                this.updater = null;
            }
            this.iri.stop('SIGKILL');
            this.updateState('iri', { status: 'stopped' });
            return this.nelson.stop().then(function () {
                _this4.updateState('nelson', { status: 'stopped' });
                return true;
            });
        }
    }, {
        key: 'startIRI',
        value: function startIRI() {
            var _this5 = this;

            this.updateState('iri', { status: 'starting' });
            return new Promise(function (resolve) {
                _this5.iri.start();

                var getNodeInfo = function getNodeInfo() {
                    setTimeout(function () {
                        _this5.iri.getNodeInfo().then(function (info) {
                            _this5.message('iri', 'started');
                            _this5.updateState('iri', { status: 'running', info: info });
                            resolve();
                        }).catch(getNodeInfo);
                    }, 1000);
                };
                getNodeInfo();
            });
        }
    }, {
        key: 'startNelson',
        value: function startNelson() {
            var _this6 = this;

            this.updateState('nelson', { status: 'starting' });
            return new Promise(function (resolve) {
                _this6.nelson.start().then(function () {
                    _this6.updateState('nelson', { status: 'running', info: _this6.nelson.getNodeInfo() });
                    resolve();
                });
            });
        }
    }, {
        key: 'checkSystem',
        value: function checkSystem() {
            var _this7 = this;

            this.updateState('system', { status: 'checking' });
            return this.system.hasEnoughSpace().then(function (hasEnoughSpace) {
                _this7.updateState('system', { hasEnoughSpace: hasEnoughSpace });
                return _this7.system.hasJavaInstalled();
            }).then(function (hasJavaInstalled) {
                _this7.updateState('system', { hasJavaInstalled: hasJavaInstalled });
            }).then(function () {
                var _state$system = _this7.state.system,
                    hasEnoughSpace = _state$system.hasEnoughSpace,
                    hasJavaInstalled = _state$system.hasJavaInstalled;

                var isSupportedPlatform = _this7.system.isSupportedPlatform();
                var hasEnoughMemory = _this7.system.hasEnoughMemory();
                var isReady = isSupportedPlatform && hasEnoughMemory && hasEnoughSpace && hasJavaInstalled;
                _this7.updateState('system', {
                    status: isReady ? 'ready' : 'error',
                    isSupportedPlatform: isSupportedPlatform,
                    hasEnoughMemory: hasEnoughMemory,
                    error: hasEnoughSpace ? hasJavaInstalled ? isSupportedPlatform ? hasEnoughMemory ? '' : 'not enough RAM (+3.6GB)' : 'operating system is not supported' : 'java v1.8.0_151 or higher is not installed' : 'not enough free space in home or temp directory (+8GB)'
                });
                return isReady;
            });
        }
    }, {
        key: 'install',
        value: function install(component) {
            var _this8 = this;

            var installer = null;
            switch (component) {
                case 'iri':
                    installer = this.iriInstaller;
                    break;
                case 'database':
                default:
                    installer = this.databaseInstaller;
            }
            this.updateState(component, { status: 'checking' });
            return new Promise(function (resolve, reject) {
                if (installer.isInstalled()) {
                    _this8.updateState(component, { status: 'ready' });
                    resolve();
                } else {
                    installer.install(function (progress) {
                        return _this8.updateState(component, { status: 'downloading', progress: progress });
                    }, function () {
                        _this8.updateState(component, { status: 'ready' });
                        resolve();
                    }, function (error) {
                        _this8.updateState(component, { status: 'error', error: error.message });
                        installer.uninstall();
                        reject(error);
                    });
                }
            });
        }
    }, {
        key: 'updateState',
        value: function updateState(component, state) {
            this.state[component] = Object.assign(this.state[component], state);
            this.opts.onStateChange(this.state);
        }
    }, {
        key: 'message',
        value: function message(component, _message) {
            this.messages[component].push(_message);
            this.messages[component] = this.messages[component].splice(-this.opts.maxMessages);
            this.opts.onMessage(component, _message, this.messages);
        }
    }, {
        key: 'getState',
        value: function getState() {
            return this.state;
        }
    }]);

    return Controller;
}();

module.exports = {
    Controller: Controller,
    DEFAULT_OPTIONS: DEFAULT_OPTIONS
};