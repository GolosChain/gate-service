// Описание переменных окружения смотри в Readme.
const env = process.env;

module.exports = {
    FRONTEND_GATE_LISTEN_PORT: env.FRONTEND_GATE_LISTEN_PORT,
    FRONTEND_GATE_TIMEOUT_FOR_CLIENT: env.FRONTEND_GATE_TIMEOUT_FOR_CLIENT,
};
