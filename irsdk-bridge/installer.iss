[Setup]
AppName=OMORAY PITWALL Bridge
AppVersion=1.0
AppPublisher=OMORAY
DefaultDirName={autopf}\OMORAY PITWALL
DefaultGroupName=OMORAY PITWALL
OutputDir=installer_output
OutputBaseFilename=OMORAY-PITWALL-Setup
Compression=lzma
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=OMORAY PITWALL Bridge
CloseApplications=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "dist\OMORAY-PITWALL-Bridge.exe"; DestDir: "{app}"; Flags: ignoreversion

[Run]
Filename: "schtasks"; Parameters: "/Create /F /SC ONLOGON /DELAY 0001:00 /TN ""OMORAY PITWALL Bridge"" /TR ""{app}\OMORAY-PITWALL-Bridge.exe"" /RL HIGHEST /IT"; Flags: runhidden; StatusMsg: "Registering auto-start..."

[UninstallRun]
Filename: "schtasks"; Parameters: "/Delete /F /TN ""OMORAY PITWALL Bridge"""; Flags: runhidden

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if CurStep = ssPostInstall then
    Exec('schtasks', '/Run /TN "OMORAY PITWALL Bridge"', '', SW_HIDE, ewNoWait, ResultCode);
end;
