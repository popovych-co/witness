## Motivation

A leading or trailing hyphen makes URLs look broken (g1).

## Behavior

`slugify(title)` strips any hyphen left at the start or end of the result
after punctuation is stripped and whitespace is collapsed — a title of
`" hello "` becomes `hello`, never `-hello-`.
