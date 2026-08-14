# Security Policy

## Supported versions

The latest version published to npm is the only one that gets fixes.

## Reporting a vulnerability

Please **don't** open a public issue for a security problem.

Use GitHub's [private vulnerability reporting](https://github.com/Booyaka101/grokscope/security/advisories/new) instead. Expect a first response within a week.

Please include what you found, how to reproduce it, and what an attacker gets out of it.

## What this touches

Sends your query to xAI and caches the response locally.

- **Your `XAI_API_KEY`** is read from `GROK_API_KEY` or `XAI_API_KEY` and sent to xAI as a bearer token over HTTPS. It is not part of what gets cached: a cache file holds the response body and its metadata, nothing else.
- **Query results are cached unencrypted on disk.** Anyone who can read that directory can read your searches. Treat it like shell history.
- **`grokscope demo` makes no network calls** and needs no key. It is the safe way to reproduce a bug without exposing anything.

## Scope

In scope: anything that leaks a credential, reads data belonging to someone else, or lets untrusted input reach code execution.

Out of scope: findings that require an attacker to already control the machine it runs on.
