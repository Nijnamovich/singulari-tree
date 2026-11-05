#!/bin/sh
# Entrypoint for the SingulariTree Go core runtime image.
#
# The gRPC unix socket lives on /run/singularitree and the SQLite database on
# /data. Both must be writable by the *host* user: the core creates the socket
# with mode 0600, and the host can only connect if it is owned by the host UID.
#
# When running as root we fix ownership of the two mounts and drop privileges
# to CORE_UID:CORE_GID via su-exec (PID 1 becomes the core, so SIGTERM/SIGINT
# reach it and the 5s graceful shutdown runs). When already non-root, or when
# CORE_UID=0 is explicitly requested, we exec the core directly.
set -e

CORE_UID="${CORE_UID:-1000}"
CORE_GID="${CORE_GID:-1000}"

if [ "$(id -u)" = "0" ] && [ "$CORE_UID" != "0" ]; then
    for dir in /run/singularitree /data; do
        if [ -d "$dir" ]; then
            chown -R "$CORE_UID:$CORE_GID" "$dir"
        fi
    done
    exec su-exec "$CORE_UID:$CORE_GID" /usr/local/bin/go-core "$@"
fi

# Already non-root, or CORE_UID=0 (stay root by explicit request).
exec /usr/local/bin/go-core "$@"
