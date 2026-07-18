const { Sequelize } = require("sequelize");

const sequelize = new Sequelize("DAILY_EXECUTION", "auth", "1234", {
  host: "DESKTOP-C1F49GD",
  dialect: "mssql",
  logging: false,
  dialectOptions: {
    options: {
      encrypt: true,
      trustServerCertificate: true,
    },
  },
  pool: {
    max: 5,
    min: 0,
    idle: 30000,
  },
});

module.exports = sequelize;
