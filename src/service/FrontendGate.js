const WebSocket = require('ws');
const core = require('griboyedov');
const logger = core.Logger;
const stats = core.Stats.client;
const env = require('../Env');
const BasicService = core.service.Basic;

class FrontendGate extends BasicService {
    constructor() {
        super();

        this._lastId = 0;
        this._server = null;
        this._idMapping = new Map();
        this._deadMapping = new Map();
        this._brokenDropperIntervalId = null;
    }

    async start(callback) {
        logger.info('Make Gate server...');

        const timer = new Date();
        const port = env.FRONTEND_GATE_LISTEN_PORT;

        this._server = new WebSocket.Server({ port });
        this._callback = callback;

        this._server.on('connection', this._handleConnection.bind(this));
        this._makeBrokenDropper();

        stats.timing('make_gate_server', new Date() - timer);
        logger.info(`Gate server listening at ${port}`);
    }

    async stop() {
        clearInterval(this._brokenDropperIntervalId);

        if (this._server) {
            this._server.close();
        }
    }

    _handleConnection(socket, request) {
        const from = this._getRequestAddressLogString(request);
        const uuidMap = this._idMapping;
        const deadMap = this._deadMapping;

        socket.on('message', message => {
            deadMap.set(socket, false);
            this._handleMessage(socket, message, from);
        });

        socket.on('open', () => {
            logger.log(`Gate server connection open - ${from}`);

            uuidMap.set(socket, ++this._lastId);
            deadMap.set(socket, false);
            this._notifyCallback(socket, 'open');
        });

        socket.on('close', () => {
            logger.log(`Gate server connection close - ${from}`);

            uuidMap.delete(socket);
            deadMap.delete(socket);
            this._notifyCallback(socket, 'close');
        });

        socket.on('error', error => {
            logger.log(`Frontend Gate client error - ${error}`);

            this._safeTerminateSocket(socket);

            uuidMap.delete(socket);
            deadMap.delete(socket);
            this._notifyCallback(socket, 'error');
        });

        socket.on('pong', () => {
            deadMap.set(socket, false);
        });
    }

    _getRequestAddressLogString(request) {
        const ip = request.connection.remoteAddress;
        const forwardHeader = request.headers['x-forwarded-for'];
        let forward = '';
        let result = ip;

        if (forwardHeader) {
            forward = forwardHeader.split(/\s*,\s*/)[0];
            result += `<= ${forward}`;
        }

        return result;
    }

    _makeBrokenDropper() {
        const deadMap = this._deadMapping;

        this._brokenDropperIntervalId = setInterval(() => {
            for (let socket of deadMap.keys()) {
                if (deadMap.get(socket) === true) {
                    this._safeTerminateSocket(socket);
                    deadMap.delete(socket);
                } else {
                    deadMap.set(socket, true);
                    socket.ping(this._noop);
                }
            }
        }, env.FRONTEND_GATE_TIMEOUT_FOR_CLIENT);
    }

    _handleMessage(socket, message, from) {
        const requestData = this._deserializeMessage(message);

        if (requestData.error) {
            this._handleConnectionError(socket, requestData, from);
        } else {
            this._notifyCallback(socket, requestData);
        }
    }

    _notifyCallback(socket, requestData) {
        const id = this._idMapping(socket);

        if (typeof requestData === 'string') {
            this._callback(id, requestData);
        } else {
            this._callback(id, requestData, responseData => {
                socket.send(this._serializeMessage(responseData));
            });
        }
    }

    _safeTerminateSocket(socket) {
        try {
            socket.terminate();
        } catch (error) {
            // already terminated
        }
    }

    _handleConnectionError(socket, data, from) {
        stats.increment('gate_server_connection_error');
        logger.error(`Gate server connection {${from}} error - ${data.error}`);
    }

    _serializeMessage(data) {
        let result;

        try {
            result = JSON.stringify(data);
        } catch (error) {
            stats.increment('gate_serialization_error');
            logger.error(`Gate serialization error - ${error}`);
            process.exit(1);
        }

        return result;
    }

    _deserializeMessage(message) {
        let data;

        try {
            data = JSON.parse(message);
        } catch (error) {
            return { error };
        }

        return data;
    }

    _noop() {
        // just empty function
    }
}

module.exports = FrontendGate;
