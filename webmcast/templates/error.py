render = lambda request, code, message='': DOCTYPE + html(
  head(
    meta(charset="utf-8"),
    link(rel="stylesheet", href="/static/css/uikit.min.css"),
    link(rel="stylesheet", href="/static/css/layout.css"),
    title('webmcast / ', code),
  ),
  body.uk_flex.uk_flex_row(
    div.uk_flex_item_none.uk_flex.uk_flex_column(
      div.uk_flex_item_1(),
      div.uk_flex_item_none(
          img(src="/static/img/%s.png" % code) if code in {404} else '',
          style="width:340px; margin: 60px",
      ),
      div.uk_flex_item_1(),
    ),
    div.uk_margin.uk_flex_item_1.uk_flex.uk_flex_column.uk_block(
      div.uk_flex_item_auto(
        h1.uk_heading_large(code, ' ',
          small.uk_text_danger(
            { 400: 'bad request',
              403: 'FOREBODEN',
              404: 'not found',
              405: 'not doing that',
              409: 'gone',
              418: 'i\'m a little teapot',
              500: 'internal server error' }.get(code, '???'),
          ),
        ),
        h2({400: 'Malformed EBML.',
            403: 'Invalid stream token.',
            404: '* Annoying Dog absorbs the page.',
            405: 'Streams can only be GET or POSTed.',
            409: 'This world has been erased.',
            418: 'The coffee machine is at udp:192.168.3.15.',
            500: 'This is an error-handling message.',
           }.get(code, 'There is nothing special about that code.')
           if message is None else message),
      ),
      div.uk_flex_item_none(
        h3({ 400: 'Try sending something nice instead.',
             403: 'Try not being a dirty hacker.',
             404: ['Try ', a.uk_text_danger('resetting to the beginning', href='/'), '.'],
             405: 'Try a different course of action.',
             409: '<!-- Try giving up your SOUL. -->',
             418: 'Try buying a donut.',
             500: ['Try ', a.uk_text_danger('submitting a bug report',
                              href='https://github.com/pyos/webmcast'), '.'],
           }.get(code, 'Try something else.')
        ),       ),
      ),
    error=code),
)
