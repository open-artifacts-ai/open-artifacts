# A brand-new member's machine: Linux, clean home, Node and the Claude Code CLI. Nothing else.
FROM node:22-bookworm
RUN npm install -g @anthropic-ai/claude-code@latest && npm cache clean --force
RUN useradd -m -s /bin/bash member
USER member
WORKDIR /home/member/conference-site
RUN git init -q . && git config user.email member@example.invalid && git config user.name Member && \
    printf '# Conference site\n\nPlanning notes and the public site for the spring conference.\n' > README.md && \
    git add . && git commit -qm init
CMD ["sleep","infinity"]
