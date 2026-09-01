# Security Policy

## Supported Versions
Only the most recent version of Lumia is supported.

We don't offer bug fixes or security updates for old versions. 

## Valid Vulnerabilities
Vulnerabilities in this project mostly fall into one of the following categories:
- Server-Side Request Forgery (SSRF) bypasses allowing internal network access during link resolution.
- Being able to crash the entire bot instance via malformed media (e.g. ffmpeg vulnerabilities).
- Being able to modify settings or bypass moderation checks in a guild without appropriate permissions.
- Injecting custom code into the bot or escaping sandbox limits.
- Overloading the instance and making the bot unusable on other servers via unmitigated DoS vectors.

The following are explicitly not vulnerabilities inside Lumia:
- Poorly configured slash command permissions which allow unauthorized users to change Lumia's configuration.
- Discord's native auto-embeds resolving internal IPs (Lumia does not control Discord's proxy).

## Reporting a Vulnerability
Please do not create a public issue about security vulnerabilities. To prevent abuse of the vulnerability before a fix is available please create a private report here: https://github.com/festivities/Lumia/security/advisories
