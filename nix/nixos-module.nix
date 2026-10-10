{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.mars;
in
{
  options.programs.mars = {
    enable = lib.mkEnableOption "Mars coding agent";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "inputs.mars.packages.${pkgs.stdenv.hostPlatform.system}.default";
      description = "Mars package to install system-wide.";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ cfg.package ];
  };
}
