"""Runs a PowerShell script on the Windows test machine over WinRM (NTLM, encrypted), for test/suites/windows.ts.

The suite pipes this file to `python3 -` on the SSH host (which needs pywinrm: `pip install pywinrm`), followed by
a call to main() with the address, account and script, so the password never appears on a command line.
Prints the script's output; exits with its status.
"""
import sys

import winrm


def main(request):
    user = request["user"]
    if "\\" not in user and "@" not in user:
        user = ".\\" + user  # a local account
    session = winrm.Session(
        f"http://{request['address']}/wsman",
        auth=(user, request["password"]),
        transport="ntlm",
        message_encryption="always",
        operation_timeout_sec=60,
        read_timeout_sec=70,
    )
    result = session.run_ps("$ProgressPreference = 'SilentlyContinue'\n" + request["script"])
    sys.stdout.buffer.write(result.std_out)
    if result.status_code:
        sys.stdout.buffer.write(result.std_err)
    sys.exit(result.status_code)
