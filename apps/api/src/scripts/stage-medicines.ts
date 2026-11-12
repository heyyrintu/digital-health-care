import { parseArgs } from 'node:util';
import { stageDirectory } from '../modules/medicine-staging/directory';

// Deliberately no .env loading, database connection, network client or publish command.
try {
  const { values } = parseArgs({
    options: {
      input: { type: 'string' },
      output: { type: 'string' },
      previous: { type: 'string' },
      help: { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help)
    process.stdout.write(
      'Stage synthetic medicine files: --input <directory> --output <new directory> [--previous <completed stage directory>]. No database writes or publication.\n',
    );
  else {
    if (!values.input || !values.output)
      throw new Error('Supply --input and --output. Use --help for usage.');
    process.stdout.write(
      JSON.stringify(await stageDirectory(values.input, values.output, values.previous), null, 2) +
        '\n',
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Medicine staging failed.');
  process.exitCode = 1;
}
