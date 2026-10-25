/** Multiline form input using the shared text-field material and focus treatment. */
import { forwardRef, type TextareaHTMLAttributes } from 'react'
import clsx from 'clsx'
import css from './Input.module.css'

/**
 * Render a multiline form field with native newline and validation behavior.
 * @param props - Native textarea attributes, including controlled value and localized labels.
 * @param ref - The native textarea element.
 * @returns The themed textarea without automatic focus or save shortcuts.
 */
export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function TextArea({ className, ...props }, ref) {
    return <textarea ref={ref} className={clsx(css.wrap, css.textarea, className)} {...props} />
  },
)
