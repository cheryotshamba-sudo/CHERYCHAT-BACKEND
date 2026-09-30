const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "CheryChat Backend is running",
        status: "online"
    });
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
    console.log(`CheryChat backend running on port ${PORT}`);
});
