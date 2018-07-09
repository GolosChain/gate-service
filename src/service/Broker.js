const R = require('ramda');
const jayson = require('jayson');
const random = require('randomstring');
const golos = require('golos-js');
const core = require('griboyedov');
const logger = core.Logger;
const stats = core.Stats.client;
const BasicService = core.service.Basic;
const env = require('../Env');
const errors = require('../Error');

class Broker extends BasicService {
    constructor(InnerGate, FrontendGate) {
        super();

        this._innerGate = new InnerGate();
        this._frontendGate = new FrontendGate();
        this._userMapping = new Map(); // channelId -> user
        this._innerServices = null; // Set
    }

    async start() {
        const inner = this._innerGate;
        const front = this._frontendGate;
        const requiredClients = inner._makeDefaultRequiredClientsConfig(env);

        this._innerServices = new Set(Object.keys(requiredClients));

        await inner.start({
            serverRoutes: {
                transfer: this._transferToClient.bind(this),
            },
            requiredClients,
        });

        await front.start(async (channelId, data, send) => {
            if (R.is(String, data)) {
                await this._handleFrontendEvent(channelId, data, send);
            } else {
                await this._handleRequest(channelId, data, send);
            }
        });

        this.addNested(inner, front);
    }

    async stop() {
        await this.stopNested();
    }

    async _handleFrontendEvent(channelId, event, send) {
        const userMap = this._userMapping;

        switch (event) {
            case 'open':
                const request = this._makeAuthRequestObject();

                userMap.set(channelId, null);
                send(request);
                break;

            case 'close':
                await this._notifyAboutUserOfflineBy(channelId);
                userMap.delete(channelId);
                break;

            case 'error':
                await this._notifyAboutUserOfflineBy(channelId);
                userMap.delete(channelId);
                break;
        }
    }

    async _handleRequest(channelId, data, send) {
        const parsedData = await this._parseRequest(data);

        if (parsedData.error) {
            send(parsedData);
            return;
        }

        if (this._userMapping.get(channelId) === null) {
            await this._authClient(channelId, data, send);
        } else {
            await this._handleClientRequest(channelId, data, send);
        }
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

    async _authClient(channelId, data, send) {
        const timer = new Date();

        if (!this._validateClientAuth(data)) {
            send(errors.E406);
            return;
        }

        const { user, sign } = data.params;
        const signObject = this._makeUserFakeTransactionObject(user, sign);
        const verified = await golos.api.verifyAuthorityAsync(signObject);

        if (verified) {
            send(this._makeResponseObject(['Passed'], data.id));

            this._userMapping.set(channelId, user);
            await this._notifyAboutUserOnline(user, true);
        } else {
            send(errors.E403);
        }

        stats.timing('user_auth', new Date() - timer);
    }

    async _validateClientAuth(data) {
        const params = data.params;

        if (!params) {
            return false;
        }

        return R.all(R.is(String), [params.user, params.sign]);
    }

    _makeUserFakeTransactionObject(user, sign) {
        return {
            ref_block_num: 3367,
            ref_block_prefix: 879276768,
            expiration: '2018-07-06T14:52:24',
            operations: [
                [
                    'vote',
                    {
                        voter: user,
                        author: 'test',
                        permlink: 'test',
                        weight: 1,
                    },
                ],
            ],
            extensions: [],
            signatures: [sign],
        };
    }

    async _handleClientRequest(channelId, data, send) {
        const serviceName = this._getTargetServiceName(data);

        if (!serviceName) {
            send(errors.E404);
            return;
        }

        const method = this._normalizeMethodName(data);
        const translate = this._makeTranslateToServiceData(channelId, data);

        try {
            const response = await this._innerGate.sendTo(
                serviceName,
                method,
                translate
            );

            send(response);
        } catch (error) {
            stats.increment(`pass_data_to_${serviceName}_error`);
            logger.error(
                `Fail to pass data from client to service - [${serviceName}, ${method}, ${data}] - ${error}`
            );

            send(errors.E503);
        }
    }

    _getTargetServiceName(data) {
        let serviceName = null;
        let path = data.method.split('.');

        if (path.length < 2) {
            return null;
        }

        serviceName = path[0];

        if (this._innerServices.has(serviceName)) {
            return serviceName;
        } else {
            return null;
        }
    }

    _normalizeMethodName(data) {
        return data.method
            .split('.')
            .slice(1)
            .join();
    }

    _makeTranslateToServiceData(channelId, data) {
        return {
            _frontendGate: true,
            channelId,
            requestId: data.id,
            user: this._userMapping(channelId),
            params: data.params,
        };
    }

    // TODO -
    async _transferToClient(data) {
        const { id, uuid, user, error, result } = data;
        const userMap = this._userMapping;
        const pipeMap = this._pipeMaping;

        if (!this._userMapping.has(user)) {
            return errors.E404;
        }

        const pipe = pipeMap.get(userMap.get(user));
        let response;

        if (error) {
            response = this._makeResponseErrorObject(error);
        } else {
            response = this._makeResponseObject(result);
        }

        pipe(response);
    }

    async _notifyAboutUserOfflineBy(channelId) {
        const user = this._userMapping.get(channelId);

        if (user) {
            await this._notifyAboutUserOnline(user, false);
        }
    }

    async _notifyAboutUserOnline(name, isOnline) {
        // TODO add notify logic when make first two-way service
    }

    _makeAuthRequestObject() {
        return jayson.utils.request('sign', [random.generate()], null);
    }

    _makeResponseObject(data, id = null) {
        return jayson.utils.response(null, data, id);
    }

    _makeResponseErrorObject({ code, message }) {
        return errors.makeRPCErrorObject(code, message);
    }
}

module.exports = Broker;


