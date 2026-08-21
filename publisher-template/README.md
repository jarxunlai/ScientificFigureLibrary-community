# Personal signed Provider template

The SFL 0.6.0 personal-provider protocol publishes these generated artifacts:

```text
source-manifest.json
source-manifest.sig.json
catalog.json
previews.zip
```

The Ed25519 private key belongs only in a protected publisher GitHub Actions secret. Never commit it. Publish the raw 32-byte public key independently so users can verify its fingerprint before their first Add Plan. A manifest-declared key is not a first-trust source.

The signing workflow must sign the exact UTF-8 bytes of `source-manifest.json`; it must not parse and re-stringify the manifest between digesting and signing.
