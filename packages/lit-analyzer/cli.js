#!/usr/bin/env node

require("./index.js")
	.cli()
	.catch(err => {
		// A crash during analysis must never read as success (exit 0).
		// eslint-disable-next-line no-console
		console.error(err && err.stack ? err.stack : err);
		process.exit(1);
	});
