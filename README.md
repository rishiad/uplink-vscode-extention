# Uplink - Open Remote SSH Extension

Remote SSH extention for code oss editors

## Features

- Connect to remote hosts via SSH
- Browse and manage SSH targets
- Automatic server setup on remote hosts
- SSH config file integration
- Dynamic port forwarding
- Agent forwarding support

## Installation

Build from source and install the VSIX.

## Usage

1. Open Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
2. Run `Uplink: Connect to Host...`
3. Select or enter SSH host
4. VSCode will connect and open a remote window

## Configuration

Enable the extension in your `argv.json` which you can open by running the `Preferences: Configure Runtime Arguments` command.

```json
{
    ...
    "enable-proposed-api": [
        ...,
        "rishiad.uplink",
    ]
    ...
}
```

## Development

### Prerequisites

- Node.js 20+
- Rust toolchain
- VSCode

### Setup

```bash
npm install
npm run build:native
npm run compile
```

### Testing

```bash
npm test
```

### Building

```bash
npm run package
```

Creates `.vsix` file for distribution.

## Contributing

Contributions welcome. Please open an issue first to discuss changes.

## License

MIT - See [LICENSE](LICENSE) file.
