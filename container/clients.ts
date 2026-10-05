import { stderr, stdout } from "node:process";
import { Infrastructure } from "../src/docker.ts";
import { Network } from "../src/network.ts";

const usage = "Usage: panda logs <el|cl|vc> [--tail <N|all>] [--follow] | panda validator-token";
export function clientCommand(args: string[]):
  | { command: "validator-token" }
  | { command: "logs"; role: "el" | "bn" | "vc"; tail: number | "all"; follow: boolean } {
  if (args.length === 1 && args[0] === "validator-token") return { command: "validator-token" };
  const [command, client, ...options] = args;
  if (command !== "logs" || !["el", "cl", "vc"].includes(client)) throw new Error(usage);
  let tail: number | "all" = 300;
  let follow = false;
  for (let i = 0; i < options.length; i++) {
    if (options[i] === "--follow" || options[i] === "-f") follow = true;
    else if (options[i] === "--tail") {
      const value = options[++i];
      if (value === "all") tail = value;
      else if (/^\d+$/.test(value ?? "") && Number.isSafeInteger(Number(value))) {
        tail = Number(value);
      } else throw new Error(usage);
    } else throw new Error(usage);
  }
  return { command, role: client === "cl" ? "bn" : client as "el" | "vc", tail, follow };
}

if (import.meta.main) {
  try {
    const command = clientCommand(Deno.args);
    const id = (await Deno.readTextFile("/run/panda/id")).trim();
    const infra = new Infrastructure(id);
    if (command.command === "validator-token") {
      const manifest = await Network.manifest(id);
      const token = await Deno.readTextFile(
        `${manifest.directory}/validator-keys/keys/api-token.txt`,
      );
      console.log(token.trim());
    } else {
      await infra.clientLogs(command.role, command, stdout, stderr);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exitCode = 1;
  }
}
