require("dotenv").config();
const express = require("express");
const app = express();
const sequelizeConnection = require("./config/database");
const dailyExecutionRoute = require("./routes/dailyexecution.routes");
const internalRoutes = require("./routes/internal.routes")
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  res.send("Daily execution service running.....");
});

app.use("/day", dailyExecutionRoute);
app.use("/internal", internalRoutes);

 
sequelizeConnection
  .authenticate()
  .then(() => {
    console.log("Database connection has been established successfully.");
    return sequelizeConnection.sync();
  })
  .then(() => {
    const PORT = process.env.PORT || 6001;
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Error occured while syncing database: ", err);
  });

module.exports = app;
