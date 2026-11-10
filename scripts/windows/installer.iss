#ifndef Payload
  #define Payload "..\..\build\desktop"
#endif
[Setup]
AppId=io.browserharness.desktop
AppName=Browser Harness
AppVersion=0.2.0
DefaultDirName={localappdata}\Programs\BrowserHarness
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
DisableProgramGroupPage=yes
DisableDirPage=yes
OutputDir=..\..\artifacts
OutputBaseFilename=BrowserHarnessSetup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\BrowserHarnessHost.exe
CloseApplications=yes

[Files]
Source: "{#Payload}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Registry]
Root: HKCU; Subkey: "Software\Google\Chrome\NativeMessagingHosts\io.browserharness.host"; ValueType: string; ValueName: ""; ValueData: "{app}\io.browserharness.host.json"; Flags: uninsdeletekey

[Icons]
Name: "{userprograms}\Browser Harness setup guide"; Filename: "{app}\first-run.html"

[Run]
Filename: "{app}\BrowserHarnessHost.exe"; Parameters: "--setup"; Description: "Show the Chrome extension setup guide"; Flags: postinstall nowait skipifsilent
