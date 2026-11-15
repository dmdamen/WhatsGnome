# Dev/test image: all tooling runs here, nothing is installed on the host.
FROM registry.fedoraproject.org/fedora:45
RUN dnf install -y --setopt=install_weak_deps=False \
        gjs gtk4 libadwaita webkitgtk6.0 lcov zip \
    && dnf clean all
WORKDIR /src
