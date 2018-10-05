const WebSocket = require('ws');
const uuid = require('uuid');
const core = require('gls-core-service');
const logger = core.utils.Logger;
const stats = core.utils.statsClient;
const RpcObject = core.utils.RpcObject;
const BasicService = core.services.Basic;
const env = require('../env');

class FrontendGate extends BasicService {
    constructor() {
        super();

        this._server = null;
        this._pipeMapping = new Map(); // socket -> uuid
        this._deadMapping = new Map(); // socket -> boolean
        this._brokenDropperIntervalId = null;
    }

    async start(callback) {
        logger.info('Make Frontend Gate server...');

        const timer = new Date();
        const host = env.GLS_FRONTEND_GATE_HOST;
        const port = env.GLS_FRONTEND_GATE_PORT;

        this._server = new WebSocket.Server({ host, port });
        this._callback = callback;

        this._server.on('connection', this._handleConnection.bind(this));
        this._makeBrokenDropper();

        stats.timing('make_gate_server', new Date() - timer);
        logger.info(`Frontend Gate listening at ${port}`);
    }

    async stop() {
        clearInterval(this._brokenDropperIntervalId);

        if (this._server) {
            this._server.close();
        }
    }

    _handleConnection(socket, request) {
        const from = this._getRequestAddressLogString(request);
        const pipeMap = this._pipeMapping;
        const deadMap = this._deadMapping;

        logger.log(`Frontend Gate connection open - ${from}`);

        pipeMap.set(socket, uuid());
        deadMap.set(socket, false);
        this._notifyCallback(socket, 'open');

        socket.on('message', message => {
            deadMap.set(socket, false);
            this._handleMessage(socket, message, from);
        });

        socket.on('close', () => {
            logger.log(`Frontend Gate connection close - ${from}`);

            this._notifyCallback(socket, 'close');
            pipeMap.delete(socket);
            deadMap.delete(socket);
        });

        socket.on('error', error => {
            logger.log(`Frontend Gate client connection error - ${error}`);

            this._safeTerminateSocket(socket);

            this._notifyCallback(socket, 'error');
            pipeMap.delete(socket);
            deadMap.delete(socket);
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
        }, env.GLS_FRONTEND_GATE_TIMEOUT_FOR_CLIENT);
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
        const pipe = this._pipeMapping.get(socket);

        this._callback(pipe, requestData, responseData => {
            if (!this._pipeMapping.get(socket)) {
                logger.log('Client close connection before get response.');
                return;
            }

            socket.send(this._serializeMessage(responseData, requestData.id));
        }).catch(error => {
            logger.error(`Frontend Gate internal server error ${error}`);
            socket.send(
                this._serializeMessage(
                    RpcObject.error(1107, 'Internal server error on response to client'),
                    requestData.id
                ),
                () => {
                    // do noting, just notify or pass
                }
            );
            stats.increment('frontend_gate_internal_server_error');
        });
    }

    _safeTerminateSocket(socket) {
        try {
            socket.terminate();
        } catch (error) {
            // already terminated
        }
    }

    _handleConnectionError(socket, data, from) {
        stats.increment('frontend_gate_connection_error');
        logger.error(`Frontend Gate connection error [${from}] - ${data.error}`);
    }

    _serializeMessage(data, defaultId = null) {
        let result;

        data = Object.assign({}, data);
        data.id = data.id || defaultId;

        if (data.id === null || data.id === 'rpc-notify') {
            delete data.id;
        }

        try {
            result = JSON.stringify(data);
        } catch (error) {
            stats.increment('frontend_gate_serialization_error');
            logger.error(`Frontend Gate serialization error - ${error}`);

            let errorData = Object.assign(
                {},
                RpcObject.error(1108, 'Internal server error on serialize message')
            );

            errorData.id = defaultId;

            result = JSON.stringify(errorData);
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
