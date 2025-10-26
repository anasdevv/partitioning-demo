import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import knex from "knex";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
console.log(" config " , process.env.DB_PORT);
 const config = {
  development: {
    client: "pg",
    connection: {
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    },
    migrations: {
      directory: join(__dirname, "migrations"),
      extension: "js",
    },
    seeds: {
      directory: join(__dirname, "seeds"),
    },
    pool: {
      min: 2,
      max: 10,
    },
  },
};


export default config;