#!/bin/bash
# Seed for the Audiobookshelf hunt (docs/adoption/hunts/audiobookshelf.md): 220 books "<Word> <Noun>" (20 words x 11
# nouns, so prefixes such as "Har" match several titles) by 40 authors, one 2 s sine mp3 each, under $1 (default
# ~/abs-data/books). Then, with the server running: POST /init (root user), POST /login, POST /api/libraries with
# this folder, POST /api/libraries/:id/scan (the commands are in the report, section 1).
set -e
out=${1:-$HOME/abs-data/books}
words=(Harbor Hardy Harvest Harmony Hart Silver Silent Sila Winter Wind River Rivet Stone Storm Story Ember Echo Eclipse Moon Morrow)
nouns=(Tales Road House Song Keep Garden Letters Light Sea Field Gate)
i=0
for w in "${words[@]}"; do for n in "${nouns[@]}"; do
  i=$((i+1)); [ $i -gt 300 ] && break 2
  a=$(( (i % 40) + 1 ))
  d="$out/Author $a/$w $n"
  mkdir -p "$d"
  ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=$((200+i)):duration=2" -metadata title="$w $n" -metadata artist="Author $a" -metadata album="$w $n" "$d/book.mp3"
done; done
echo "$i books"
