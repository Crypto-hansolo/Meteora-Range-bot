import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "./config.js";

export const connection = new Connection(config.rpcUrl, {
  commitment: "confirmed",
  wsEndpoint: config.wsUrl,
});

export const payer = Keypair.fromSecretKey(bs58.decode(config.payerSecretKey));
