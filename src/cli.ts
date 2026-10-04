#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { runConnectionsCommand, type CliIO } from './cli-connections.js';

const defaultIo: CliIO = {
  stdout: (text: string) => { process.stdout.write(text); },
  stderr: (text: string) => { process.stderr.write(`${text}\n`); },
};

export async function runCli(argv: string[], io: CliIO = defaultIo): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== 'connections') {
    io.stderr('invalid_request: supported command is `connections`');
    return 2;
  }
  return (await runConnectionsCommand(rest, io)).exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
