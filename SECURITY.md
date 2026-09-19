# Security

This early project has no dedicated security response team or response-time commitment. Do not post secrets or a working exploit involving private systems in a public issue. If this repository's host offers private vulnerability reporting, use it; otherwise open a minimal issue requesting a private contact without disclosing exploit details.

Treat input text, model answers, and circuits supplied by another party as untrusted. Model output does not establish identity, authorization, payment status, or successful tool execution. Keep those checks in application code, and use a narrow action allowlist in any integration.

Network providers send selected input and, for layered nodes, the selected prior signals to their configured endpoint. Use endpoints you control or trust. Keep credentials in environment variables or application configuration; do not put them in circuits, fixtures, or source control. A LocalJev endpoint may forward data to another server according to its own configuration.

Trace files may reveal answers, labels, instructions reflected by a provider, and operational metadata. Digests help identify inputs but are not anonymization. Review traces before sharing them and apply your own storage and retention controls.

Please report validation bypasses, credential leakage, unintended tool execution, or situations where malformed answers become confident signals. Include the package version and a sanitized reproduction.
