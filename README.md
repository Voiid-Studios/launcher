# Voiid Studios Launcher

Official installers and signed updates for Windows x64, macOS Intel and macOS Apple Silicon are available under [Releases](https://github.com/Voiid-Studios/launcher/releases).

This repository contains build infrastructure and distributable binaries. The launcher source is proprietary and remains in a separate private repository.

Builds accept only exact commits in the private repository's `main` history. Source is downloaded into temporary runner storage and is never pushed here. Compiler output, source archives, build caches, signing keys and source maps are not uploaded. Only the explicitly selected installers, update signatures and update manifests are transferred between jobs. Temporary artifacts expire after one day.

Production builds retain the launcher's existing JavaScript obfuscation, disabled source maps and stripped native release binaries. These measures make analysis harder; distributed applications can still be reverse engineered.

Builds run only by authenticated manual/API dispatch from this repository's `main` branch. Pull requests, forks and pushes do not trigger privileged builds. Only trusted maintainers should have write access to this repository or its build configuration.
