const R = require('ramda');
const jayson = require('jayson');
const random = require('randomstring');
const golos = require('golos-js');
const errors = require('../Error');
const core = require('griboyedov');
const logger = core.Logger;
const stats = core.Stats.client;
const BasicService = core.service.Basic;

class Broker extends BasicService {
    constructor(InnerGate, FrontendGate) {
        super();

        this._innerGate = new InnerGate();
        this._frontendGate = new FrontendGate();
        this._userMapping = new Map();
        this._userPipeMaping = new Map();
    }

    async start() {
        await this._innerGate.start({
            serverRoutes: {
                transfer: this._transferToClient.bind(this),
            },
        });

        await this._frontendGate.start(async (uuid, data, send) => {
            if (R.is(String, data)) {
                await this._handleFrontendEvent(uuid, data, send);
            } else {
                await this._handleRequest(uuid, data, send);
            }
        });

        this.addNested(this._innerGate, this._frontendGate);
    }

    async stop() {
        await this.stopNested();
    }

    _parseRequest(data) {
        return new Promise((resolve, reject) => {
            const fakeJaysonRouter = {
                router: () => new jayson.Method(() => resolve(data)),
            };
            const fakeJaysonServer = jayson.server({}, fakeJaysonRouter);

            try {
                fakeJaysonServer.call(data, rpcError => resolve(rpcError));
            } catch (parseError) {
                reject(parseError);
            }
        });
    }

    async _handleFrontendEvent(uuid, event, send) {
        const userMap = this._userMapping;

        switch (event) {
            case 'open':
                const payload = random.generate();
                const request = jayson.utils.request('sign', [payload], null);

                userMap.set(uuid, null);
                send(request);
                break;

            case 'close':
                userMap.delete(uuid);
                // TODO notify
                break;

            case 'error':
                userMap.delete(uuid);
                // TODO notify
                break;
        }
    }

    async _handleRequest(uuid, data, send) {
        const parsedData = await this._parseRequest(data);

        if (parsedData.error) {
            send(parsedData);
            return;
        }

        if (this._userMapping.get(uuid) === null) {
            await this._authClient(uuid, data, send);
        } else {
            await this._handleClientRequest(uuid, data, send);
        }
    }

    async _authClient(uuid, data, send) {
        const timer = new Date();

        if (!this._validateClientAuth(data)) {
            send(errors.E406);
            return;
        }

        // TODO -

        // TODO notify

        stats.timing('user_auth', new Date() - timer);
    }

    async _validateClientAuth(data) {
        const params = data.params;

        if (!params) {
            return false;
        }

        return R.all(R.is(String), [params.user, params.sign]);
    }

    async _handleClientRequest(uuid, data, send) {
        // TODO -
    }

    // TODO -
    async _transferToClient(data) {
        const { id, uuid, user, error, result } = data;
        const userMap = this._userMapping;
        const pipeMap = this._userPipeMaping;

        if (!this._userMapping.has(user)) {
            return errors.E404;
        }

        const pipe = pipeMap.get(userMap.get(user));
        let response;

        if (error) {
            response = errors.makeRPCErrorObject(error.code, error.message);
        } else {
            response = jayson.utils.response(null, result, null);
        }

        pipe(response);
    }
}

module.exports = Broker;
