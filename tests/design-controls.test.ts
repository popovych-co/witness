import { describe, expect, it } from 'vitest'
import { lookControls } from '../src/design.js'

const page = (body: string) => '<!doctype html>\n<html><body>\n' + body + '\n</body></html>\n'
const rows = (html: string) => lookControls(html).map((c) => [c.anchor, c.line, c.kind, c.holds])

describe('lookControls — a look\'s controls from markup (row 215)', () => {
  it('lists every option of a select — markup, a label, a bare "<", optional end tags (issue #73)', () => {
    expect(rows(page(['<section id="reject-form">', '<select id="reject-reason" aria-label="Reject reason">',
      '<option><span class="dot"></span>Unsafe code</option><option>Doesn&#39;t work',
      '<option label="Not from the author"></option><option>< 1 hour</option><option>  </option>',
      '<option label="Short">Long reason</option>', '</select></section>'].join('\n')))).toEqual([
      ['reject-reason', 4, 'select', "Unsafe code | Doesn't work | Not from the author | < 1 hour | Short"]])
  })

  it('a customizable select, and a comment inside a select, change nothing (issue #73)', () => {
    expect(rows(page('<select id="s"><button><selectedcontent></selectedcontent></button><option>A</option><!-- <option>Legacy</option> --><!-- </select> --><option>B</option></select>')))
      .toEqual([['s', 3, 'select', 'A | B']])
  })

  it('lists a closed details by its first-child summary, "Details" without one, never an open one (issue #73)', () => {
    expect(rows(page(['<div id="a"><details><p>no summary</p></details>',
      '<details>\n  <summary>What happens on <b>reject</b>?</summary><p>x</p></details>',
      '<details open><summary>Shown</summary></details></div>'].join('\n'))))
      .toEqual([['a', 3, 'details', 'Details'], ['a', 4, 'details', 'What happens on reject?']])
  })

  it.each([
    ['a comment that names <script>', '<!-- the <script> at implement --><details id="d"><summary>D</summary></details>', [['d', 3, 'details', 'D']]],
    ["a script holding '<!--'", "<script>const s = '<!--'</script><details id=\"d\"><summary>D</summary></details><!-- x -->", [['d', 3, 'details', 'D']]],
    ['a custom element named style-*', '<style-guide id="sg"><details><summary>A</summary></details></style-guide>', [['sg', 3, 'details', 'A']]],
    ['a quoted ">" before hidden', '<div id="k" title="a > b" hidden>x</div>', [['k', 3, 'hidden', 'a > b']]],
    ["an apostrophe in an unquoted value", "<img alt=Don't src=\"data:,x\"><details id=\"d\"><summary>More</summary></details><p title='x'>t</p>", [['d', 3, 'details', 'More']]],
    ['</path> is not </p', '<p id="p" hidden><svg><path></path></svg> Saved</p>', [['p', 3, 'hidden', 'Saved']]],
    ['a "</scripts>" string in a script', '<script>var s = "</scripts>"; s = "<dialog>x</dialog>"</script><dialog id="z" aria-label="Z"></dialog>', [['z', 3, 'dialog', 'Z']]],
    ['an upper-case </SCRIPT>', '<SCRIPT>x()</SCRIPT><details id="d"><summary>D</summary></details>', [['d', 3, 'details', 'D']]],
    ['İ before a script', 'İ'.repeat(40) + '<script>x()</script><details id="d"><summary>D</summary></details>', [['d', 3, 'details', 'D']]],
    ['an svg <title/>, and an svg left open before a div', '<svg><title/><title>t</title><div><textarea><dialog>no</dialog></textarea></div><details id="d"><summary>D</summary></details>', [['d', 3, 'details', 'D']]],
    ['<script/> and <template/> on HTML elements', '<script/>document.write("<dialog>no</dialog>")</script><template/><dialog>inert</dialog></template><dialog id="y" aria-label="Y"></dialog>', [['y', 3, 'template', 'template'], ['y', 3, 'dialog', 'Y']]],
    ['nested templates', '<template><template></template><dialog>no</dialog></template><dialog id="y" aria-label="Y"></dialog>', [['y', 3, 'template', 'template'], ['y', 3, 'dialog', 'Y']]],
    ['a template body holding comments and </TEMPLATE>', '<template id="t"><!-- cloned from this <template> --><!-- ends at </template> --><dialog>inert</dialog></TEMPLATE><details id="d"><summary>D</summary></details>', [['t', 3, 'template', 'template'], ['d', 3, 'details', 'D']]],
    ['<noscript>, <details.x>, <xmp>, --!> and <!-->', '<noscript><dialog>no</dialog></noscript><details.x>no</details.x><xmp><dialog>no</dialog></xmp><!-- a --!><!--><dialog id="v" aria-label="V"></dialog>', [['v', 3, 'dialog', 'V']]],
    ['a tag the source ends inside', '<dialog id="v" aria-label="V"></dialog><div hidden title="never', [['v', 3, 'dialog', 'V']]],
  ])('%s misleads nothing (issue #73)', (_name, body, want) => expect(rows(page(body))).toEqual(want))

  it('lists nothing inside a comment, script, style, template or noscript, nor after an unclosed comment (issue #73)', () => {
    expect(rows(page(['<!-- <select id="ghost"><option>no</option></select> -->',
      "<script>document.body.innerHTML = '<dialog>no</dialog>'</script>", '<style>/* <details> */</style>',
      '<template id="row" aria-label="Row"><details><summary>no</summary></details></template>',
      '<noscript><div hidden>no</div></noscript>', '<!-- unclosed', '<details><summary>no</summary></details>'].join('\n'))))
      .toEqual([['row', 6, 'template', 'Row']])
  })

  it("anchors to the element's own id as the outline reads it, else the span holding its line (issue #73)", () => {
    expect(rows(page(['<div id="a"><select><option>x</option></select></div><div id="b"><dialog aria-label="Confirm"></dialog><select id="c"><option>y</option></select></div>',
      '<select><option>z</option></select><div id="d">d</div>', '<p hidden id=bare>q</p>', '<p hidden data-id="q7">r</p>'].join('\n')))).toEqual([
      ['a', 3, 'select', 'x'], ['b', 3, 'dialog', 'Confirm'], ['c', 3, 'select', 'y'], ['d', 4, 'select', 'z'], ['d', 5, 'hidden', 'q'], ['q7', 6, 'hidden', 'r']])
    expect(rows(page('<select><option>x</option></select>\n<div id="a">a</div>'))).toEqual([['-', 3, 'select', 'x']])
  })

  it.each([
    ['<dialog id="k">\n  <h2>Delete</h2>\n  <p>this item?</p>\n</dialog>', 'dialog', 'Delete this item?'],
    ['<div id="k" hidden>\n  <div class="step">Step 1</div>\n  <div>Control-click the app</div>\n</div>', 'hidden', 'Step 1 Control-click the app'],
    ['<div id="k" popover>Tip</div>', 'popover', 'Tip'],
    ['<ul id="k" role="menu" aria-label="Actions"><li>x</li></ul>', 'menu', 'Actions'],
    ['<div id="k" role="listbox" title="Pick one">a</div>', 'listbox', 'Pick one'],
    ['<section id="k" role="alertdialog" aria-labelledby="t"><h2 id="t">Sure <em>now</em>?</h2></section>', 'alertdialog', 'Sure now?'],
    ['<button id="k" aria-expanded="false">More</button>', 'collapsed', 'More'],
    ['<p id="k" hidden>Pick <b>a reason</b> first.</p>', 'hidden', 'Pick a reason first.'],
    ['<p id="k" hidden><b>Pick</b> <i>one</i></p>', 'hidden', 'Pick one'],
    ['<p id="k" hidden>Step 1<br>Pick a reason</p>', 'hidden', 'Step 1 Pick a reason'],
    ['<p id="k" style="color:red; display: none">Gone</p>', 'hidden', 'Gone'],
    ['<div id="k" class="guide pane" hidden></div>', 'hidden', 'div.guide'],
    ['<details id="k" open hidden><summary>S</summary></details>', 'hidden', 'S'],
    ['<select id="k"></select>', 'select', 'select'],
    ['<textarea id="k" hidden>Default</textarea><p>Shown paragraph</p>', 'hidden', 'Default'],
    ['<template id="k" aria-label="Row"><p>r</p></template>', 'template', 'Row'],
  ])('lists %s as %s (issue #73)', (markup, kind, holds) => {
    expect(rows(page(`<main id="x">${markup}</main>`))).toEqual([['k', 3, kind, holds]])
  })

  it('block elements with no whitespace between them never glue words; inline ones still join (issue #73)', () => {
    expect(rows(page('<main id="x"><div id="k" hidden><div class="mrow"><div class="k">Step 1</div><div class="v">Control-click the app</div></div><p>Use <b>Settings</b>.</p></div></main>')))
      .toEqual([['k', 3, 'hidden', 'Step 1 Control-click the app Use Settings.']])
  })

  it('never lists an open dialog, a disabled, class-hidden or comment-styled element, aria-hidden, an option or a summary (issue #73)', () => {
    expect(rows(page(['<main id="x"><dialog open>Hi</dialog><button disabled>Go</button><p class="err hidden">E</p>',
      '<div title="a hidden gem">g</div><svg aria-hidden="true"><path d="m9 18 6-6"/></svg><p style="/* display:none */ color:red">c</p>',
      '<select><option hidden>Pick one</option><option>A</option></select>',
      '<details><summary aria-expanded="false">S</summary></details></main>'].join('\n'))))
      .toEqual([['x', 5, 'select', 'Pick one | A'], ['x', 6, 'details', 'S']])
  })

  it('decodes entities once and turns an impossible code point into U+FFFD (issue #73)', () => {
    expect(rows(page('<main id="x"><select><option>a &amp;lt;b&amp;gt; &#39;c&#39;</option><option>&#99999999;&#0;&#xD800;</option></select></main>'))[0]![3])
      .toBe("a &lt;b&gt; 'c' | \u{FFFD}\u{FFFD}\u{FFFD}")
  })

  it('spells out control and format characters, and marks every cut with "…" (issue #73)', () => {
    expect(rows(page('<main id="x"><dialog aria-label="&#27;[2Jx&#x202e;"></dialog></main>'))[0]![3]).toBe('\\x1b[2Jx\\u{202e}')
    const long = lookControls(page(`<main id="x"><dialog aria-label="${'😀'.repeat(200)}"></dialog></main>`))[0]!.holds
    expect([...long]).toHaveLength(120)
    expect(long.endsWith('…')).toBe(true)
    const runs = lookControls(page(`<main id="x"><p hidden>${Array.from({ length: 60 }, (_, i) => `<b>  w${i}  </b>`).join('')}</p></main>`))[0]!.holds
    expect(runs.endsWith('…')).toBe(true)
  })

  it.each([
    ['<!--'], ['<details '], ['<a '], ['<select><option>'], ['<a ', '">'], ['<div hidden>', '</div>'], ['<dialog>', '</dialog>'],
    ['<details><summary>', '</summary>'], ['<select>', '</select>'], ['<p hidden aria-labelledby="t">', '<h2 id="t">T</h2>'],
    ['<p hidden><br>', '</p>'], ['<i id="a"></i><p hidden>', ''], ['<template>', ''], ['<p hidden style="/* ', '">'],
  ])('scans %j ×40,000 in linear time (issue #73)', (junk, tail = '') => {
    const t0 = performance.now()
    lookControls(junk.repeat(40_000) + tail)                       // bare: no trailing ">" from a page wrapper
    expect(performance.now() - t0).toBeLessThan(1500)
  })
})
