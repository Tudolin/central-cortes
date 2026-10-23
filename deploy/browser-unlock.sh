#!/usr/bin/with-contenv bash
# Roda na inicialização do container do navegador (custom-cont-init.d do linuxserver).
# O Chromium recusa um perfil "em uso por outro computador" quando o container é recriado; remove a trava velha.
rm -f /config/robo-tiktok/SingletonLock /config/robo-tiktok/SingletonCookie /config/robo-tiktok/SingletonSocket
