const WebSocket = require('ws');
const core = require('griboyedov');
const logger = core.Logger;
const stats = core.Stats.client;
const env = require('../Env');
const BasicService = core.service.Basic;

class FrontendGate extends BasicService {
    constructor(routesConfig) {
        super();

        this._server = null;
        this._deadMapping = new Map();
        this._brokenDropperIntervalId = null;
        this._router = this._makeRouter(routesConfig);
    }

    async start() {
        logger.info('Make Gate server...');

        const timer = new Date();
        const port = env.FRONTEND_GATE_PORT;

        this._server = new WebSocket.Server({ port });

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

        socket.on('message', message => {
            this._deadMapping.set(socket, false);
            this._handleMessage(socket, message, from);
        });

        socket.on('open', () => {
            logger.log(`Gate server connection open - ${from}`);
        });

        socket.on('close', () => {
            logger.log(`Gate server connection close - ${from}`);
        });

        socket.on('error', error => {
            // TODO -
        });

        socket.on('pong', () => {
            this._deadMapping.set(socket, false);
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
        const map = this._deadMapping;

        this._brokenDropperIntervalId = setInterval(() => {
            for (let socket of this._server.clients) {
                if (map.get(socket) === true) {
                    socket.terminate();
                } else {
                    map.set(socket, true);
                    socket.ping(this._noop);
                }
            }
        }, env.GATE_SERVER_TIMEOUT);
    }

    _handleMessage(socket, message, from) {
        const data = this._deserializeMessage(message);

        if (data.error) {
            this._handleConnectionError(socket, data, from);
        } else {
            this._routeMessage(socket, data);
        }
    }

    _handleConnectionError(socket, data, from) {
        stats.increment('gate_server_connection_error');
        logger.error(`Gate server connection {${from}} error - ${data.error}`);
    }

    _makeRouter(config) {
        return (data, responseSender) => {
            const routes = config.routes;
            const scope = config.scope || null;
            const target = data.target;

            if (routes[target]) {
                routes[target]
                    .call(scope, data)
                    .then(responseSender)
                    .catch(responseSender);
            } else {
                responseSender({ error: 'Route not found' });
            }
        };
    }

    _routeMessage(socket, requestData) {
        this._router(requestData, responseData => {
            socket.send(this._serializeMessage(responseData));
        });
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

    static _noop() {
        // just empty function
    }
}

module.exports = FrontendGate;