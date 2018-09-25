const core = require('gls-core-service');
const stats = core.utils.statsClient;
const logger = core.utils.Logger;
const InnerGate = core.services.Connector;
const BasicService = core.services.Basic;
const env = require('./Env');
const Broker = require('./service/Broker');
const FrontendGate = require('./service/FrontendGate');

class Main extends BasicService {
    constructor() {
        super();

        this.printEnvBasedConfig(env);
        this.addNested(new Broker(InnerGate, FrontendGate));
        this.stopOnExit();
    }

    async start() {
        await this.startNested();
        stats.increment('main_service_start');
    }

    async stop() {
        await this.stopNested();
        stats.increment('main_service_stop');
        process.exit(0);
    }
}

new Main().start().then(
    () => {
        logger.info('Main service started!');
    },
    error => {
        logger.error(`Main service failed - ${error}`);
        process.exit(1);
    }
);
