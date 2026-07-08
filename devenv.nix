{
  pkgs,
  lib,
  config,
  inputs,
  ...
}:
let
  pkgs-staging = import inputs.nixpkgs-staging {
    system = pkgs.stdenv.system;
  };

  # FHS environment for running the downloaded generic-linux VS Code in
  # vscode-lit-plugin's headful tests (@vscode/test-electron). NixOS ships only
  # the inert stub-ld at /lib64/ld-linux, so the binary won't exec directly;
  # this wrapper provides a glibc loader + Electron's runtime shared libraries.
  # Usage: lit-fhs -c "cd packages/vscode-lit-plugin && npm run test:normal"
  lit-fhs = pkgs.buildFHSEnv {
    name = "lit-fhs";
    targetPkgs =
      p:
      [ pkgs-staging.nodejs_26 ]
      ++ (with p; [
        git
        # Electron / VS Code runtime libraries
        glib
        nss
        nspr
        atk
        at-spi2-atk
        at-spi2-core
        cups
        dbus
        libdrm
        gtk3
        pango
        cairo
        gdk-pixbuf
        mesa
        libgbm # libgbm.so.1 (split out of mesa in recent nixpkgs)
        libGL
        alsa-lib
        expat
        libxkbcommon
        libsecret
        systemd # libudev
        xorg.libX11
        xorg.libXcomposite
        xorg.libXdamage
        xorg.libXext
        xorg.libXfixes
        xorg.libXrandr
        xorg.libxcb
        xorg.libXScrnSaver
        xorg.libxshmfence
        xorg.libXtst
        xorg.libXi
        xorg.libXcursor
        xorg.libXrender
      ]);
    runScript = "bash";
  };
in
{
  packages = with pkgs; [
    git
    pkgs-staging.nodejs_26
    lit-fhs
  ];
  languages.python.enable = true;
  languages.typescript.enable = true;

  enterShell = ''
    git --version # Use packages

    # If the user's login shell is zsh, hand off to it instead of devenv's
    # default bash — so zsh autosuggestions/completion work inside the shell.
    # Read the login shell from /etc/passwd: $SHELL is unreliable here (devenv
    # overwrites it, and it points at bash even in the outer zsh).
    # Bash-login machines skip this and stay in bash.
    if [[ $- == *i* && -z "''${ZSH_VERSION:-}" && -z "''${_DEVENV_IN_ZSH:-}" ]] \
       && [[ "$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)" == */zsh ]]; then
      export _DEVENV_IN_ZSH=1
      exec zsh
    fi
  '';

  # See full reference at https://devenv.sh/reference/options/
}
