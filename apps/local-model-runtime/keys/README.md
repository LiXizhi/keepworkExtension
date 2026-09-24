# Model signing keys

`model-signing-public.pem` is the trusted Ed25519 public key used to verify model
package manifests. Private keys must never be committed. During development,
`npm run model:sign -- --generate-dev-key` creates an ignored key under `.keys/`.
