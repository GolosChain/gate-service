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
    constructor(FrontendGate) {
        super();

        this._frontendGate = new FrontendGate();
        this._userMapping = new Map();
    }

    async start() {
        await this._frontendGate.start(async (id, data, send) => {
            if (R.is(String, data)) {
                await this._handleFrontendEvent(id, data, send);
            } else {
                await this._handleRequest(id, data, send);
            }
        });

        this.addNested(this._frontendGate);
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

    async _handleFrontendEvent(id, event, send) {
        const userMap = this._userMapping;

        switch (event) {
            case 'open':
                const payload = random.generate();
                const request = jayson.utils.request('sign', [payload]);

                userMap.set(id, null);
                send(request);
                break;

            case 'close':
                userMap.delete(id);
                // TODO notify
                break;

            case 'error':
                userMap.delete(id);
                // TODO notify
                break;
        }
    }

    async _handleRequest(id, data, send) {
        const parsedData = await this._parseRequest(data);

        if (parsedData.error) {
            send(parsedData);
            return;
        }

        if (this._userMapping.get(id) === null) {
            await this._authClient(id, data, send);
        } else {
            // TODO handle request
        }
    }

    async _authClient(id, data, send) {
        if (!this._validateClientAuth(data)) {
            send(errors.E406);
            return;
        }

        const { user, sign } = data.params;
        const userData = await golos.api.getAccountsAsync([user]);

        // TODO -
    }

    async _validateClientAuth(data) {
        const params = data.params;

        if (!params) {
            return false;
        }

        return R.all(R.is(String), [params.user, params.sign]);
    }
}

module.exports = Broker;
