## ADDED Requirements

### Requirement: Todos occupy the current conversation body

The native TodoPanel SHALL render as a floating capsule in the top-right of its own conversation body through a declared Session-scoped overlay position. It MUST preserve status counts, expandable details and keyboard operation. Positioning MUST NOT use generated class names or fixed browser-window coordinates.

#### Scenario: Multiple conversation bodies
- **WHEN** two Sessions are visible or navigation changes the Session
- **THEN** each capsule displays only its owning Session's todos and remains inside that body

### Requirement: Narrow bodies hide the capsule safely

The capsule SHALL hide when its conversation container cannot accommodate it, independently of viewport width, and SHALL NOT create page-wide horizontal scrolling. Expanded content SHALL remain readable within bounded scrolling space, with native focus and reduced-motion behavior.

#### Scenario: Wide viewport with narrow embedded Session
- **WHEN** the browser is wide but the Session body is narrow
- **THEN** the capsule is hidden for that body without changing other Sessions

#### Scenario: Keyboard interaction
- **WHEN** the user focuses the capsule and activates it with the keyboard
- **THEN** expanded state and full task text are available, and Escape closes the details
