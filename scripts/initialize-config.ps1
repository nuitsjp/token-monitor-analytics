$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Add-Type -TypeDefinition @'
using System;
using System.Security.AccessControl;
using System.Security.Principal;

public sealed class DaclNativeSecurity : NativeObjectSecurity
{
    public DaclNativeSecurity(bool isContainer) : base(isContainer, ResourceType.FileObject) { }

    public override Type AccessRightType { get { return typeof(FileSystemRights); } }
    public override Type AccessRuleType { get { return typeof(FileSystemAccessRule); } }
    public override Type AuditRuleType { get { return typeof(FileSystemAuditRule); } }

    public override AccessRule AccessRuleFactory(
        IdentityReference identityReference,
        int accessMask,
        bool isInherited,
        InheritanceFlags inheritanceFlags,
        PropagationFlags propagationFlags,
        AccessControlType type)
    {
        return new FileSystemAccessRule(
            identityReference,
            (FileSystemRights)accessMask,
            inheritanceFlags,
            propagationFlags,
            type);
    }

    public override AuditRule AuditRuleFactory(
        IdentityReference identityReference,
        int accessMask,
        bool isInherited,
        InheritanceFlags inheritanceFlags,
        PropagationFlags propagationFlags,
        AuditFlags flags)
    {
        return new FileSystemAuditRule(
            identityReference,
            (FileSystemRights)accessMask,
            inheritanceFlags,
            propagationFlags,
            flags);
    }

    public void AddRule(AccessRule rule)
    {
        AddAccessRule(rule);
    }

    public void PersistDacl(string path)
    {
        Persist(path, AccessControlSections.Access);
    }
}
'@

function Resolve-RepositoryRoot {
    $scriptRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
    $parentPath = [System.IO.Path]::GetFullPath((Join-Path -Path $scriptRoot -ChildPath '..'))
    return (Resolve-Path -LiteralPath $parentPath).ProviderPath
}

function Resolve-RepositoryChild {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepositoryRoot,
        [Parameter(Mandatory = $true)]
        [string]$RelativePath
    )

    $root = [System.IO.Path]::GetFullPath($RepositoryRoot).TrimEnd('\')
    $candidate = [System.IO.Path]::GetFullPath((Join-Path -Path $root -ChildPath $RelativePath))
    $rootPrefix = $root + [System.IO.Path]::DirectorySeparatorChar
    if (-not $candidate.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'setup_target_outside_repository'
    }
    return $candidate
}

function Assert-ExistingRepositoryChild {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepositoryRoot,
        [Parameter(Mandatory = $true)]
        [string]$Candidate
    )

    if (-not (Test-Path -LiteralPath $Candidate)) {
        return
    }
    $resolved = (Resolve-Path -LiteralPath $Candidate).ProviderPath
    $root = [System.IO.Path]::GetFullPath($RepositoryRoot).TrimEnd('\')
    $rootPrefix = $root + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'setup_target_outside_repository'
    }
}

function Get-ProtectedIdentities {
    $identities = @(
        [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        [System.Security.Principal.SecurityIdentifier]::new(
            [System.Security.Principal.WellKnownSidType]::LocalSystemSid,
            $null
        )
        [System.Security.Principal.SecurityIdentifier]::new(
            [System.Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid,
            $null
        )
    )
    $seen = New-Object 'System.Collections.Generic.HashSet[string]'
    foreach ($identity in $identities) {
        if ($null -eq $identity) {
            throw 'current_user_sid_unavailable'
        }
        if ($seen.Add($identity.Value)) {
            $identity
        }
    }
}

function Set-ProtectedAcl {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [bool]$Directory
    )

    $acl = [DaclNativeSecurity]::new($Directory)
    $acl.SetAccessRuleProtection($true, $false)

    if ($Directory) {
        $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
            [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else {
        $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
    }
    $propagation = [System.Security.AccessControl.PropagationFlags]::None
    $rights = [System.Security.AccessControl.FileSystemRights]::FullControl
    $accessType = [System.Security.AccessControl.AccessControlType]::Allow

    foreach ($identity in Get-ProtectedIdentities) {
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
            $identity,
            $rights,
            $inheritance,
            $propagation,
            $accessType
        )
        $acl.AddRule($rule)
    }
    $acl.PersistDacl($Path)
}

try {
    $repositoryRoot = Resolve-RepositoryRoot
    $envPath = Resolve-RepositoryChild -RepositoryRoot $repositoryRoot -RelativePath '.env'
    $envExamplePath = Resolve-RepositoryChild -RepositoryRoot $repositoryRoot -RelativePath '.env.example'
    $localPath = Resolve-RepositoryChild -RepositoryRoot $repositoryRoot -RelativePath '.local'
    $hubConfigPath = Resolve-RepositoryChild -RepositoryRoot $repositoryRoot -RelativePath '.local\hubs.json'
    $hubExamplePath = Resolve-RepositoryChild -RepositoryRoot $repositoryRoot -RelativePath 'hubs.example.json'

    Assert-ExistingRepositoryChild -RepositoryRoot $repositoryRoot -Candidate $envPath
    Assert-ExistingRepositoryChild -RepositoryRoot $repositoryRoot -Candidate $envExamplePath
    Assert-ExistingRepositoryChild -RepositoryRoot $repositoryRoot -Candidate $localPath
    Assert-ExistingRepositoryChild -RepositoryRoot $repositoryRoot -Candidate $hubConfigPath
    Assert-ExistingRepositoryChild -RepositoryRoot $repositoryRoot -Candidate $hubExamplePath

    if (-not (Test-Path -LiteralPath $envExamplePath -PathType Leaf)) {
        throw 'environment_example_missing'
    }
    if (-not (Test-Path -LiteralPath $hubExamplePath -PathType Leaf)) {
        throw 'hub_example_missing'
    }

    if (Test-Path -LiteralPath $envPath -PathType Container) {
        throw 'environment_path_is_directory'
    }
    if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
        Copy-Item -LiteralPath $envExamplePath -Destination $envPath
    }

    if (Test-Path -LiteralPath $localPath -PathType Leaf) {
        throw 'local_path_is_file'
    }
    if (-not (Test-Path -LiteralPath $localPath -PathType Container)) {
        New-Item -ItemType Directory -Path $localPath | Out-Null
    }

    if (Test-Path -LiteralPath $hubConfigPath -PathType Container) {
        throw 'hub_config_path_is_directory'
    }
    if (-not (Test-Path -LiteralPath $hubConfigPath -PathType Leaf)) {
        Copy-Item -LiteralPath $hubExamplePath -Destination $hubConfigPath
    }

    Set-ProtectedAcl -Path $localPath -Directory $true
    Set-ProtectedAcl -Path $hubConfigPath -Directory $false
    Write-Output 'Local configuration is ready.'
} catch {
    Write-Error 'Local configuration setup failed.'
    exit 1
}
