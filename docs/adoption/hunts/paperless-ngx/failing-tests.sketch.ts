// Failing test sketches for docs/adoption/hunts/paperless-ngx.md, for the person who writes the fix by hand.
// NOT a patch for submission (Paperless-ngx's CONTRIBUTING: "We will not accept PRs that are entirely or mostly
// AI-derived"). Each block goes inside the existing `describe` of the named spec file in src-ui (Jest 30 via
// @angular-builders/jest), uses that file's own setup (`component`, `fixture`, `searchService`, `notesService`,
// `searchResults`, `notes`), and needs `Subject` added to the file's `rxjs` import.
// Measured on paperless-ngx dev at cc15aa0180bb907a218d3b12e1e3471866652388 (2026-11-03), three runs each:
// A and B fail on the unchanged component, C fails on the unchanged component; all three passed with the local change
// described in the report (section 8), and every other test in both spec files still passed.
//   cd src-ui && npx jest src/app/components/app-frame/global-search src/app/components/document-notes

// ---------------------------------------------------------------------------------------------------------------
// src/app/components/app-frame/global-search/global-search.component.spec.ts

// A. results of an earlier query must not replace those of the query in the box
it('should show the latest query results when an earlier search responds last', () => {
  jest.useFakeTimers()
  const first = new Subject<any>()
  const second = new Subject<any>()
  jest
    .spyOn(searchService, 'globalSearch')
    .mockReturnValueOnce(first)
    .mockReturnValueOnce(second)
  component.onQueryChange('doc')
  jest.advanceTimersByTime(401)
  component.onQueryChange('document 12')
  jest.advanceTimersByTime(401)
  const latest = { ...searchResults, total: 1 }
  second.next(latest)
  second.complete()
  first.next(searchResults) // the slower answer for "doc" arrives last
  first.complete()
  expect(component.searchResults()).toBe(latest)
  jest.useRealTimers()
})

// B. a search cleared with Escape must not reopen the dropdown when its answer arrives
it('should not show results for a query cleared before the search responded', () => {
  jest.useFakeTimers()
  const pending = new Subject<any>()
  jest.spyOn(searchService, 'globalSearch').mockReturnValueOnce(pending)
  const openSpy = jest.spyOn(component.resultsDropdown, 'open')
  component.onQueryChange('doc')
  jest.advanceTimersByTime(401)
  component.searchInputKeyDown(new KeyboardEvent('keydown', { key: 'Escape' }))
  pending.next(searchResults)
  pending.complete()
  expect(component.searchResults()).toBeNull()
  expect(openSpy).not.toHaveBeenCalled()
  jest.useRealTimers()
})

// ---------------------------------------------------------------------------------------------------------------
// src/app/components/document-notes/document-notes.component.spec.ts

// C. Ctrl+Enter while a note is being saved must not save it again (the Add button is disabled then)
it('should not add the same note twice on repeated ctrl+Enter', () => {
  component.documentId.set(12)
  const noteTextArea = fixture.debugElement.query(By.css('textarea'))
  noteTextArea.nativeElement.value = 'This is the new note.'
  noteTextArea.nativeElement.dispatchEvent(new Event('input'))
  fixture.detectChanges()
  const saving = new Subject<any>()
  const addSpy = jest.spyOn(notesService, 'addNote').mockReturnValue(saving)
  const ctrlEnter = () =>
    noteTextArea.nativeElement.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true })
    )
  ctrlEnter()
  ctrlEnter() // the first save has not answered yet
  expect(addSpy).toHaveBeenCalledTimes(1)
})
