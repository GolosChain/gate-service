const R = require('ramda');
const jayson = require('jayson');
const random = require('randomstring');
const golos = require('golos-js');
const core = require('gls-core-service');
const logger = core.utils.Logger;
const stats = core.utils.statsClient;
const BasicService = core.services.Basic;
const RpcObject = core.utils.RpcObject;
const env = require('../env');

class Broker extends BasicService {
    constructor(InnerGate, FrontendGate) {
        super();

        this._innerGate = new InnerGate();
        this._frontendGate = new FrontendGate();
        this._userMapping = new Map(); // channelId -> user
        this._pipeMapping = new Map(); // channelId -> pipe
        this._secretMapping = new Map(); // channelId -> secret
    }

    async start() {
        const inner = this._innerGate;
        const front = this._frontendGate;

        await inner.start({
            serverRoutes: {
                transfer: this._transferToClient.bind(this),
            },
            requiredClients: {
                facade: env.GLS_FACADE_CONNECT,
            },
        });

        await front.start(async (channelId, data, pipe) => {
            if (R.is(String, data)) {
                await this._handleFrontendEvent(channelId, data, pipe);
            } else {
                await this._handleRequest(channelId, data, pipe);
            }
        });

        this.addNested(inner, front);
    }

    async stop() {
        await this.stopNested();
    }

    async _handleFrontendEvent(channelId, event, pipe) {
        const userMap = this._userMapping;
        const pipeMap = this._pipeMapping;
        const secretMap = this._secretMapping;

        switch (event) {
            case 'open':
                const secret = this._generateSecret();
                const request = this._makeAuthRequestObject(secret);

                userMap.set(channelId, null);
                secretMap.set(channelId, secret);

                pipe(request);
                break;

            case 'close':
            case 'error':
                const user = userMap.get(channelId);

                userMap.delete(channelId);
                pipeMap.delete(channelId);
                secretMap.delete(channelId);

                await this._notifyAboutOffline(user, channelId);
                break;
        }
    }

    async _handleRequest(channelId, data, pipe) {
        const parsedData = await this._parseRequest(data);

        if (parsedData.error) {
            pipe(parsedData);
            return;
        }

        if (this._userMapping.get(channelId) === null) {
            await this._handleAnonymousRequest(channelId, data, pipe);
        } else {
            await this._handleClientRequest(channelId, data, pipe);
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

    async _handleAnonymousRequest(channelId, data, pipe) {
        switch (data.method) {
            case 'getSecret':
                await this._resendAuthSecret(channelId, data, pipe);
                break;

            case 'auth':
                await this._authClient(channelId, data, pipe);
                break;

            case 'registration.getState':
            case 'registration.firstStep':
            case 'registration.verify':
            case 'registration.toBlockChain':
            case 'registration.changePhone':
            case 'registration.resendSmsCode':
            case 'registration.subscribeOnSmsGet':
            case 'rates.getActual':
            case 'rates.getHistorical':
            case 'rates.getHistoricalMulti':
            case 'content.getNaturalFeed':
            case 'content.getPopularFeed':
            case 'content.getActualFeed':
            case 'content.getPromoFeed':
                this._pipeMapping.set(channelId, pipe);
                await this._handleClientRequest(channelId, data, pipe);
                break;

            default:
                pipe(RpcObject.error(1101, 'Invalid anonymous request - access denied'));
        }
    }

    async _resendAuthSecret(channelId, data, pipe) {
        const secret = this._generateSecret();
        const response = RpcObject.response(null, { secret }, data.id);

        this._secretMapping.set(channelId, secret);
        pipe(response);
    }

    async _authClient(channelId, data, pipe) {
        const timer = new Date();

        if (!this._validateClientAuth(data)) {
            pipe(RpcObject.error(1102, 'Invalid auth request - access denied'));
            return;
        }

        const { user, sign } = data.params;
        const secret = this._secretMapping.get(channelId);
        const signObject = this._makeUserFakeTransactionObject(user, sign, secret);

        try {
            await golos.api.verifyAuthorityAsync(signObject);
        } catch (error) {
            pipe(RpcObject.error(1103, 'Blockchain verification failed - access denied'));

            stats.timing('user_failure_auth', new Date() - timer);
            return;
        }

        pipe(RpcObject.success({ status: 'OK' }, data.id));

        this._userMapping.set(channelId, user);
        this._pipeMapping.set(channelId, pipe);

        stats.timing('user_auth', new Date() - timer);
    }

    _validateClientAuth(data) {
        const params = data.params;

        if (!params) {
            return false;
        }

        return R.all(R.is(String), [params.user, params.sign]);
    }

    _makeUserFakeTransactionObject(user, sign, secret) {
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
                        permlink: secret,
                        weight: 1,
                    },
                ],
            ],
            extensions: [],
            signatures: [sign],
        };
    }

    async _handleClientRequest(channelId, data, pipe) {
        const translate = this._makeTranslateToServiceData(channelId, data);

        try {
            const response = await this._innerGate.sendTo('facade', data.method, translate);

            response.id = data.id;

            pipe(response);
        } catch (error) {
            stats.increment(`pass_data_error`);
            logger.error(`Fail to pass data from client to facade - ${error}`);

            pipe(RpcObject.error(1104, 'Fail to pass data from client to facade'));
        }
    }

    _makeTranslateToServiceData(channelId, data) {
        return {
            _frontendGate: true,
            channelId,
            requestId: data.id,
            user: this._userMapping.get(channelId),
            params: data.params || {},
        };
    }

    async _transferToClient(data) {
        const { channelId, method, error, result } = data;
        const pipe = this._pipeMapping.get(channelId);

        if (!pipe) {
            throw { code: 1105, message: 'Cant transfer to client - not found' };
        }

        try {
            let response;

            if (error) {
                response = this._makeNotifyToClientObject(method, { error });
            } else {
                response = this._makeNotifyToClientObject(method, { result });
            }

            pipe(response);
        } catch (error) {
            throw { code: 1106, message: 'Notify client fatal error' };
        }

        return 'Ok';
    }

    async _notifyAboutOffline(user, channelId) {
        await this._innerGate.sendTo('facade', 'offline', { user, channelId });
    }

    _makeAuthRequestObject(secret) {
        return this._makeNotifyToClientObject('sign', { secret });
    }

    _makeNotifyToClientObject(method, data) {
        return RpcObject.request(method, data, 'rpc-notify');
    }

    _generateSecret() {
        return random.generate();
    }
}

module.exports = Broker;
