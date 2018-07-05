const jayson = require('jayson');
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
            if (typeof data === 'string') {
                await this._handleFrontendEvent(id, data);
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

    async _handleFrontendEvent(id, data) {
        switch (data) {
            case 'open':
                // do nothing
                break;
            case 'close':
                // TODO handle close
                break;
            case 'error':
                // TODO handle error
                break;
        }
    }

    async _handleRequest(id, data, send) {
        const parsedData = await this._parseRequest(data);

        if (parsedData.error) {
            send(parsedData);
            return;
        }

        if (this._userMapping.get(id)) {
            // TODO handle request
        } else {
            // TODO handle auth
        }
    }
}

module.exports = Broker;
