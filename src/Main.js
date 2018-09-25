const core = require('gls-core-service');
const stats = core.utils.statsClient;
const InnerGate = core.services.Connector;
const BasicMain = core.services.BasicMain;
const env = require('./Env');
const Broker = require('./service/Broker');
const FrontendGate = require('./service/FrontendGate');

class Main extends BasicMain {
    constructor() {
        super(stats, env);
        this.addNested(new Broker(InnerGate, FrontendGate));
    }
}

module.exports = Main;
